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
const MEMPOOL_LIMIT = 15

// pending tx timeout should be a function of MEMPOOL_LIMIT
const PENDING_TX_TIMEOUT = 40 * 1000 // 40 seconds

const BLOCK_FAUCET_DRIPS_TIMEOUT = 60 * 1000 // 60 seconds

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
    waitArr: RequestType[]
    queue: (RequestType & { nonce: number})[]
    error: boolean
    log: Log

    queuingInProgress: boolean
    isDelayedStart: boolean
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
        this.queuingInProgress = false
        this.lastRecalibrationTimestamp = 0

        this.waitArr = []
        this.queue = []

        this.error = false
        this.isDelayedStart = true
    }

    async start() {
        this.isLegacyTransaction = await this.isLegacyTransactionType()

        setInterval(() => this.recalibrate(), 1000);

        // block requests during restart (to settle any pending txs initiated during shutdown)
        setTimeout(() => {
            this.log.info("Faucet is ready to start serving requests...")
            this.isDelayedStart = false
        }, BLOCK_FAUCET_DRIPS_TIMEOUT);
    }

    // Setup Legacy or EIP1559 transaction type
    async isLegacyTransactionType(): Promise<boolean> {
        const baseFee = (await this.web3.eth.getBlock('latest')).baseFeePerGas
        return baseFee === undefined
    }

    // Function to issue transfer transaction. For ERC20 transfers, 'id' will be a string representing ERC20 token ID
    async sendToken(
        receiver: string,
        id: string | undefined
    ): Promise<SendTokenResponse> {
        if (this.isDelayedStart) {
            return { status: 400, message: "Faucet is getting started! Please try after sometime"};
        }

        if (!this.web3.utils.isAddress(receiver)) {
            return { status: 400, message: "Invalid address! Please try again." };
        }

        // do not accept any request if mempool limit reached
        if (this.requestStatus.size >= MEMPOOL_LIMIT) {
            this.log.error(`Reached the mempool limit of ${MEMPOOL_LIMIT}`);
            return { status: 400, message: "High faucet usage! Please try after sometime" };
        }

        let amount: BN = calculateBaseUnit(this.config.DRIP_AMOUNT.toString(), this.config.DECIMALS || 18)

        // If id is provided, then it is ERC20 token transfer, so update the amount
        if (id) {
            const erc20 = this.contracts.get(id)!;
            amount = calculateBaseUnit(erc20.dripAmount.toString(), erc20.decimals || 18)
        }

        const requestId = receiver + id + Math.random().toString()

        const request: RequestType = { receiver, amount, id, requestId };
        if (this.isRecalibrating) {
            this.waitArr.push(request)
        } else {
            this.putInQueue(request)
        }

        return new Promise((resolve) => {
            const statusCheckerInterval = setInterval(async () => {
                const requestStatus = this.requestStatus.get(requestId);
                if (requestStatus) {
                    clearInterval(statusCheckerInterval)
                    this.requestStatus.delete(requestId);
                    switch (requestStatus.type) {
                        case 'pending':
                            resolve({ status: 200, message: `Transactio sent on ${this.config.NAME}`, txHash: requestStatus.txHash })
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

    balanceCheck(req: RequestType): Boolean {
        if (req.id) {
            const contract = this.contracts.get(req.id)!;
            if (contract.balance.gte(req.amount)) {
                contract.balance = contract.balance.sub(req.amount)
                return true
            }
        } else {
            if (this.balance.gte(req.amount)) {
                this.balance = this.balance.sub(req.amount)
                return true
            }
        }
        return false
    }

    putInQueue(req: RequestType) {
        this.queuingInProgress = true

        if (!this.balanceCheck(req)) {
            this.queuingInProgress = false
            this.log.warn("Faucet balance is too low! " + req.id + " " + this.getBalance(req.id))
            this.requestStatus.set(req.requestId, {
                type: "error",
                errorMessage: "Faucet balance is too low! Please try later."
            })
            return
        }

        this.queue.push({ ...req, nonce: this.nonce })
        this.nonce++

        const request = this.queue.shift()!;
        this.sendTokenUtil(request);
    }

    async sendTokenUtil(request: RequestType & { nonce: number}) {
        const { amount, receiver, nonce, id } = request;

        // request from queue is now moved to pending txs list
        this.queuingInProgress = false

        const { txHash, rawTransaction } = await this.getTransaction(receiver, amount, nonce, id)
        this.requestStatus.set(request.requestId, { type: "pending", txHash });

        /*
        * [CRITICAL]
        * If a issued tx fails/timed-out, all succeeding nonce will stuck
        * and we need to cancel/re-issue the tx with higher fee.
        */
        try {
            /*
            * asyncCallWithTimeout function can return
            * 1. successfull response
            * 2. throw API error (will be catched by catch block)
            * 3. throw timeout error (will be catched by catch block)
            */
            await asyncCallWithTimeout(
                this.web3.eth.sendSignedTransaction(rawTransaction),
                PENDING_TX_TIMEOUT,
                `Timeout reached for transaction with nonce ${nonce}`,
            )

            this.requestStatus.set(request.requestId, { type: 'confirmed', txHash})
        } catch (err: any) {
            this.log.error(err.message)
        }
    }

    async getTransaction(
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

    async recalibrate(): Promise<void> {
        if (this.isRecalibrating) {
            return;
        }

        const nowTimestamp = Date.now();
        const isTimeToRecalibrate = (nowTimestamp - this.lastRecalibrationTimestamp) / 1000 > (this.config.RECALIBRATE || 30);

        const isIdle = this.requestStatus.size === 0 && !this.queuingInProgress;
        if (isIdle && isTimeToRecalibrate) {
            this.lastRecalibrationTimestamp = nowTimestamp;
            this.isRecalibrating = true
            try {
                await this.updateNonceAndBalance()
            } finally {
                this.isRecalibrating = false
            }
        }

        if (isIdle) {
            while (this.waitArr.length !== 0) {
                this.putInQueue(this.waitArr.shift()!);
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
        return 100 * (this.requestStatus.size / MEMPOOL_LIMIT)
    }
}