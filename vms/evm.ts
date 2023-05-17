import { BN } from 'avalanche'
import Web3 from 'web3'

import { asyncCallWithTimeout, calculateBaseUnit } from './utils'
import Log from './log'
import ERC20Interface from './ERC20Interface.json'
import { RequestType, SendTokenResponse, TransactionStatus } from './evmTypes'
import { AbiItem } from 'web3-utils';
import { Account } from 'web3-core';
import { ChainType, ERC20Type } from '../types';

// cannot issue tx if no. of pending requests is > 16
const MEM_POOL_LIMIT = 15

// pending tx timeout should be a function of MEM_POOL_LIMIT
const PENDING_TX_TIMEOUT = 40 * 1000 // 40 seconds

export default class EVM {
    web3: Web3
    account: Account
    address: string;
    isLegacyTransaction: boolean
    contracts: Map<string, {
        balance: BN;
        balanceOf: (address: string) => any;
        transfer: (to: string, value: BN) => any;
        address: string,
        dripAmount: number,
        decimals: number,
        gasLimit: string,
    }>

    requestStatus: Map<string, TransactionStatus>
    nonce: number
    balance: BN
    isRecalibrating: boolean
    error: boolean
    log: Log

    lastRecalibrationTimestamp: number;
    private config: ChainType;

    constructor(config: ChainType, PK: string) {
        this.web3 = new Web3(config.RPC)
        this.account = this.web3.eth.accounts.privateKeyToAccount(PK)
        this.address = this.account.address;
        this.contracts = new Map()
        this.config = config

        this.isLegacyTransaction = false

        this.log = new Log(this.config.NAME)

        this.requestStatus = new Map();

        this.nonce = -1
        this.balance = new BN(0)

        this.isRecalibrating = false
        this.lastRecalibrationTimestamp = 0

        this.error = false
    }

    async start() {
        this.isLegacyTransaction = await this.isLegacyTransactionType()

        setInterval(() => this.recalibrate(), 1000);

        setInterval(() => this.schedule(), 1000);
    }

    // Setup Legacy or EIP1559 transaction type
    async isLegacyTransactionType(): Promise<boolean> {
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

        const requestId = receiver + erc20 + Math.random().toString()

        const request: RequestType = { receiver, amount, id: erc20, requestId };
        this.requestStatus.set(requestId, { type: 'mem-pool', request });

        return new Promise((resolve) => {
            const statusCheckerInterval = setInterval(async () => {
                const requestStatus = this.requestStatus.get(requestId);
                if (requestStatus) {
                    clearInterval(statusCheckerInterval)
                    this.requestStatus.delete(requestId);
                    switch (requestStatus.type) {
                        case 'pending':
                            resolve({ status: 200, message: `Transaction sent on ${this.config.NAME}`, txHash: requestStatus.txHash })
                            break;
                        case 'error':
                            const errorMessage = requestStatus?.errorMessage
                            resolve({ status: 400, message: errorMessage})
                            break;
                        case 'confirmed':
                            resolve({ status: 200, message: `Transaction successful on ${this.config.NAME}!`, txHash: requestStatus.txHash })
                            break;
                    }
                }
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

    async updateNonceAndBalance(): Promise<void> {
        try {
            this.nonce = await this.web3.eth.getTransactionCount(this.address, 'latest');
            this.balance = new BN(await this.web3.eth.getBalance(this.address));

            for (const [_, contract] of Array.from(this.contracts.entries())) {
                contract.balance = new BN(await contract.balanceOf(this.address).call())
            }

            this.error && this.log.info("RPC server recovered!")
            this.error = false
        } catch (err: any) {
            this.error = true
            this.log.error(err.message)
        }
    }

    isFaucetBalanceEnough(request: RequestType): boolean {
        if (request.id) {
            const contract = this.contracts.get(request.id)!;
            return contract.balance.gte(request.amount);
        } else {
            return this.balance.gte(request.amount);
        }
    }

    async processRequest(request: RequestType) {
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
        this.requestStatus.set(request.requestId, { type: "pending", txHash });

        try {
            await asyncCallWithTimeout(
              this.web3.eth.sendSignedTransaction(rawTransaction),
              PENDING_TX_TIMEOUT,
              `Timeout reached for transaction ${txHash} with nonce ${nonce}`,
            )
        } catch (err: any) {
            this.log.error(err.message);
            this.requestStatus.set(request.requestId, { type: 'error', errorMessage: err.message })
            return;
        }

        this.requestStatus.set(request.requestId, { type: 'confirmed', txHash})
    }

    async getSignedTransaction(
        to: string,
        value: BN,
        nonce: number | undefined,
        id?: string
    ): Promise<{ txHash: string, rawTransaction: string }> {
        const tx: any = {
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

        const signedTx = await this.account.signTransaction(tx);
        const txHash = signedTx.transactionHash!;
        const rawTransaction = signedTx.rawTransaction!;

        return { txHash, rawTransaction }
    }

    async getLegacyGasPrice(): Promise<number> {
        const gasPrice: number = new BN(await this.web3.eth.getGasPrice()).toNumber();
        const adjustedGas: number = Math.floor(gasPrice * 1.25)
        return Math.min(adjustedGas, parseInt(this.config.MAX_FEE))
    }

    schedule() {
        const entry = Array.from(this.requestStatus.entries())
          .find(([, request]) => request.type === 'mem-pool');
        if (!entry) {
            return;
        }
        const [requestId, transactionStatus] = entry;
        this.requestStatus.delete(requestId);
        if (transactionStatus.type === "mem-pool") {
            const request = transactionStatus.request;
            this.processRequest(request).catch((e: any) => this.log.error(e.message));
        }
    }

    async recalibrate(): Promise<void> {
        if (this.isRecalibrating) {
            return;
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
        }
    }

    async addERC20Contract(config: ERC20Type) {
        // Explicit cast to make "stateMutability" field assignable to StateMutabilityType
        const abiItem = ERC20Interface as AbiItem[];
        const contract = new this.web3.eth.Contract(abiItem, config.CONTRACTADDRESS);
        this.contracts.set(config.ID, {
            transfer: contract.methods.transfer,
            balanceOf: contract.methods.balanceOf,
            balance: new BN(0),
            address: config.CONTRACTADDRESS,
            dripAmount: config.DRIP_AMOUNT,
            decimals: config.DECIMALS,
            gasLimit: config.GASLIMIT,
        })
    }

    getFaucetUsagePercentage(): number {
        return 100 * (this.requestStatus.size / MEM_POOL_LIMIT)
    }
}