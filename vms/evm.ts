import { BN } from 'avalanche'
import Web3 from 'web3'

import { asyncCallWithTimeout, calculateBaseUnit } from './utils'
import Log from './log'
import ERC20Interface from './ERC20Interface.json'
import { RequestType, SendTokenResponse, RequestStatus } from './evmTypes'
import { AbiItem } from 'web3-utils';
import { ChainType, ERC20Type } from '../types';
import { EvmSigner } from './signer';

// cannot issue tx if no. of pending requests is > 16
const MEM_POOL_LIMIT = 15

// pending tx timeout should be a function of MEM_POOL_LIMIT
const PENDING_TX_TIMEOUT = 40 * 1000 // 40 seconds

export default class EVM {
    private config: ChainType;

    evmSigner: EvmSigner;
    web3: Web3
    address: string;
    isLegacyTransaction: boolean
    log: Log

    nonce: number
    balance: BN
    contracts: Map<string, {
        name: string;
        balance: BN;
        balanceOf: (address: string) => any;
        transfer: (to: string, value: BN) => any;
        address: string,
        dripAmount: number,
        decimals: number,
        gasLimit: string,
    }>
    requestStatus: Map<string, RequestStatus>

    nextRequestId: number = 0;
    isRecalibrating: boolean
    lastRecalibrationTimestamp: number;

    constructor(config: ChainType, evmSigner: EvmSigner) {
        this.evmSigner = evmSigner;
        this.web3 = evmSigner.web3;
        this.address = evmSigner.address;
        this.contracts = new Map()
        this.config = config

        this.isLegacyTransaction = false

        this.log = new Log(this.config.NAME)

        this.requestStatus = new Map();

        this.nonce = -1
        this.balance = new BN(0)

        this.isRecalibrating = false
        this.lastRecalibrationTimestamp = 0
    }

    async start() {
        this.isLegacyTransaction = await this.isLegacyTransactionType()

        setInterval(() => this.recalibrateAndLog(), 1000);

        setInterval(() => this.scheduleFromMemPool(), 1000);
    }

    // Setup Legacy or EIP1559 transaction type
    private async isLegacyTransactionType(): Promise<boolean> {
        const baseFee = (await this.web3.eth.getBlock('latest')).baseFeePerGas
        return baseFee === undefined
    }

    // Function to issue transfer transaction. For ERC20 transfers, 'id' will be a string representing ERC20 token ID
    async sendToken(
        receiver: string,
        erc20: string | undefined
    ): Promise<SendTokenResponse> {
        if (!this.web3.utils.isAddress(receiver)) {
            return { status: 400, message: `Invalid address ${receiver}` };
        }

        if (this.requestStatus.size >= MEM_POOL_LIMIT) {
            this.log.error(`Reached the mem pool limit of ${MEM_POOL_LIMIT}`);
            return { status: 400, message: "High faucet usage! Please try after sometime" };
        }

        let amount: BN = calculateBaseUnit(this.config.DRIP_AMOUNT.toString(), this.config.DECIMALS || 18)

        // If id is provided, then it is ERC20 token transfer, so update the amount
        if (erc20) {
            const contract = this.contracts.get(erc20)!;
            amount = calculateBaseUnit(contract.dripAmount.toString(), contract.decimals || 18)
        }

        const requestId = `${++this.nextRequestId}_${erc20 ?? 'native'}_${receiver}`;
        const request: RequestType = { receiver, amount, id: erc20, requestId };
        this.requestStatus.set(request.requestId, { type: 'mem-pool', request });
        this.log.info(this.getRequestLogPrefix(request) + ": put to mem-pool");

        return new Promise((resolve) => {
            const statusCheckerInterval = setInterval(async () => {
                const requestStatus = this.requestStatus.get(request.requestId);
                if (!requestStatus) {
                    return;
                }
                if (requestStatus.type === 'mem-pool' || requestStatus.type === 'queueing') {
                    // Continue polling the status.
                    return;
                }
                clearInterval(statusCheckerInterval);
                this.requestStatus.delete(request.requestId);
                if (requestStatus.type === 'sent') {
                    resolve({ status: 200, message: `Transaction sent on ${this.config.NAME}!`, txHash: requestStatus.txHash });
                    this.log.info(this.getRequestLogPrefix(request) + `: respond HTTP 200 txHash = ${requestStatus.txHash}`);
                    return;
                }
                if (requestStatus.type === 'error') {
                    const errorMessage = `Transaction failed: ${requestStatus?.errorMessage}`;
                    resolve({ status: 400, message: errorMessage });
                    this.log.info(this.getRequestLogPrefix(request) + `: respond HTTP 400 error ${errorMessage}`);
                    return;
                }
                throw new Error('Unknown status');
            }, 300)
        })
    }
    getBalance(id?: string): BN {
        if (id && this.contracts.get(id)) {
            return this.contracts.get(id)!.balance;
        } else {
            return this.balance
        }
    }

    private async updateNonceAndBalance(): Promise<void> {
        this.nonce = await this.web3.eth.getTransactionCount(this.address, 'latest');
        this.balance = new BN(await this.web3.eth.getBalance(this.address));

        for (const [_, contract] of Array.from(this.contracts.entries())) {
            contract.balance = new BN(await contract.balanceOf(this.address).call())
        }
    }

    private isFaucetBalanceEnough(request: RequestType): boolean {
        if (request.id) {
            const contract = this.contracts.get(request.id)!;
            return contract.balance.gte(request.amount);
        } else {
            return this.balance.gte(request.amount);
        }
    }

    private async processRequest(request: RequestType) {
        if (this.isRecalibrating) {
            this.requestStatus.set(request.requestId, { type: 'mem-pool', request })
            return;
        }

        const { amount, receiver, id } = request;

        if (!this.isFaucetBalanceEnough(request)) {
            this.log.error(`Faucet balance is too low! ${request.id}: ${this.getBalance(request.id)}`)
            this.requestStatus.set(request.requestId, {
                type: "error",
                errorMessage: "Faucet balance is too low! Please try later."
            })
            return;
        }

        const nonce = this.nonce;
        this.nonce++;

        const { txHash, rawTransaction } = await this.getSignedTransaction(receiver, amount, nonce, id)
        this.log.info(this.getRequestLogPrefix(request) + ": has been signed");

        try {
            await asyncCallWithTimeout(
              this.web3.eth.sendSignedTransaction(rawTransaction),
              PENDING_TX_TIMEOUT,
              `Timeout reached for transaction ${txHash} with nonce ${nonce}`,
            )

            this.requestStatus.set(request.requestId, { type: 'sent', txHash})
        } catch (err: any) {
            this.requestStatus.set(request.requestId, { type: 'error', errorMessage: err.message })
            throw err;
        }
    }

    private async getSignedTransaction(
        to: string,
        value: BN,
        nonce: number | undefined,
        id?: string
    ): Promise<{ txHash: string, rawTransaction: string }> {
        const tx: any = {
            from: this.address,
            type: 2,
            gas: "21000",
            nonce,
            to,
            maxPriorityFeePerGas: this.config.MAX_PRIORITY_FEE,
            maxFeePerGas: this.config.MAX_FEE,
            value
        }

        if (this.isLegacyTransaction) {
            delete tx["maxPriorityFeePerGas"]
            delete tx["maxFeePerGas"]
            tx.gasPrice = await this.getLegacyGasPrice()
            tx.type = 0
        }

        if (id) {
            const erc20 = this.contracts.get(id)!;
            const txObject = erc20.transfer(to, value);
            tx.data = txObject.encodeABI()
            tx.value = 0
            tx.to = erc20.address;
            tx.gas = erc20.gasLimit.toString();
        }

        const signedTx = await this.evmSigner.signTransaction(tx);
        const txHash = signedTx.transactionHash!;
        const rawTransaction = signedTx.rawTransaction!;

        return { txHash, rawTransaction }
    }

    private async getLegacyGasPrice(): Promise<number> {
        const gasPrice: number = new BN(await this.web3.eth.getGasPrice()).toNumber();
        const adjustedGas: number = Math.floor(gasPrice * 1.25)
        return Math.min(adjustedGas, parseInt(this.config.MAX_FEE))
    }

    private scheduleFromMemPool() {
        const memPoolEntry = Array.from(this.requestStatus.entries())
          .find(([, request]) => request.type === 'mem-pool');
        if (!memPoolEntry) {
            return;
        }
        const [requestId, status] = memPoolEntry;
        if (status.type !== "mem-pool") {
            return;
        }
        const request = status.request;
        this.requestStatus.set(requestId, { type: 'queueing', request });
        this.processRequest(request)
          .then(() => {
              this.log.info(this.getRequestLogPrefix(request) + ": successfully processed")
              this.recalibrateNextTime();
              this.recalibrateAndLog().catch(this.log.error);
          })
          .catch((e: any) => this.log.error(`Request ${requestId} failed: ${request.id} to ${request.requestId}: ${e.message}`));
    }

    private recalibrateNextTime() {
        this.lastRecalibrationTimestamp = 0;
    }

    private async recalibrateAndLog() {
        try {
            if (await this.recalibrate()) {
                const erc20Balances = Array.from(this.contracts.entries())
                  .map(([, contract]) => `${contract.name} = ${contract.balance}`)
                  .join(", ");
                this.log.info(`Recalibration success for chain ${this.config.NAME}. Native balance ${this.balance}. ERC20 balances: ${erc20Balances}`);
            }
        } catch (e: any) {
            this.log.error(`Recalibration failed: ${e.message}`)
        }
    }

    private async recalibrate(): Promise<boolean> {
        if (this.isRecalibrating) {
            return false;
        }

        const nowTimestamp = Date.now();
        const isTimeToRecalibrate = (nowTimestamp - this.lastRecalibrationTimestamp) / 1000 > (this.config.RECALIBRATE || 30);

        if (this.requestStatus.size === 0 && isTimeToRecalibrate) {
            this.lastRecalibrationTimestamp = nowTimestamp;
            this.isRecalibrating = true
            try {
                await this.updateNonceAndBalance()
            } finally {
                this.isRecalibrating = false
            }
            return true;
        }
        return false;
    }

    async addERC20Contract(config: ERC20Type) {
        // Explicit cast to make "stateMutability" field assignable to StateMutabilityType
        const abiItem = ERC20Interface as AbiItem[];
        const contract = new this.web3.eth.Contract(abiItem, config.CONTRACTADDRESS);
        this.contracts.set(config.ID, {
            name: config.NAME,
            transfer: contract.methods.transfer,
            balanceOf: contract.methods.balanceOf,
            balance: new BN(0),
            address: config.CONTRACTADDRESS,
            dripAmount: config.DRIP_AMOUNT,
            decimals: config.DECIMALS,
            gasLimit: config.GASLIMIT,
        })
    }

    private getRequestLogPrefix(request: RequestType): string {
        return `Request ${request.requestId}: ${request.amount} of ${request.id ?? 'native'} to ${request.receiver}`;
    }

    getFaucetUsagePercentage(): number {
        return 100 * (this.requestStatus.size / MEM_POOL_LIMIT)
    }
}