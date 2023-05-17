import { BN } from 'avalanche'
import Web3 from 'web3'

import { asyncCallWithTimeout, calculateBaseUnit } from './utils'
import Log from './log'
import ERC20Interface from './ERC20Interface.json'
import { ChainType, RequestType, SendTokenResponse } from './evmTypes'
import { AbiItem } from 'web3-utils';
import { Account } from 'web3-core';
import { ERC20Type } from '../types';

// cannot issue tx if no. of pending requests is > 16
const MEMPOOL_LIMIT = 15

// pending tx timeout should be a function of MEMPOOL_LIMIT
const PENDING_TX_TIMEOUT = 40 * 1000 // 40 seconds

const BLOCK_FAUCET_DRIPS_TIMEOUT = 60 * 1000 // 60 seconds

export default class EVM {
    web3: Web3
    account: Account
    address: string;
    NAME: string
    DRIP_AMOUNT: BN
    DECIMALS: number
    LEGACY: boolean
    MAX_PRIORITY_FEE: string
    MAX_FEE: string
    RECALIBRATE: number
    hasNonce: Map<string, number | undefined>
    pendingTxNonces: Set<unknown>
    hasError: Map<string, string | undefined>
    nonce: number
    balance: BN
    isRecalibrating: boolean
    waitArr: RequestType[]
    queue: (RequestType & { nonce: number})[]
    error: boolean
    log: Log
    contracts: Map<string, {
        balance: BN;
        balanceOf: (address: string) => any;
        transfer: (to: string, value: BN) => any;
        address: string,
        dripAmount: number,
        decimals: number,
        gasLimit: string,
    }>
    requestCount: number
    queuingInProgress: boolean
    blockFaucetDrips: boolean
    recalibrateNowActivated: boolean
    lastRecalibrationTimestamp: number;

    constructor(config: ChainType, PK: string) {
        this.web3 = new Web3(config.RPC)
        this.account = this.web3.eth.accounts.privateKeyToAccount(PK)
        this.address = this.account.address;
        this.contracts = new Map()

        this.NAME = config.NAME
        this.DECIMALS = config.DECIMALS || 18
        this.DRIP_AMOUNT = calculateBaseUnit(config.DRIP_AMOUNT.toString(), this.DECIMALS)
        this.MAX_PRIORITY_FEE = config.MAX_PRIORITY_FEE
        this.MAX_FEE = config.MAX_FEE
        this.RECALIBRATE = config.RECALIBRATE || 30
        this.LEGACY = false

        this.log = new Log(this.NAME)

        this.hasNonce = new Map()
        this.hasError = new Map()
        this.pendingTxNonces = new Set()

        this.nonce = -1
        this.balance = new BN(0)

        this.isRecalibrating = false
        this.queuingInProgress = false
        this.recalibrateNowActivated = false
        this.lastRecalibrationTimestamp = 0

        this.requestCount = 0
        this.waitArr = []
        this.queue = []

        this.error = false
        this.blockFaucetDrips = true
    }

    async start() {
        this.LEGACY = await this.isLegacyTransactionType()

        setInterval(() => this.recalibrateNonceAndBalance(), 1000);

        // block requests during restart (to settle any pending txs initiated during shutdown)
        setTimeout(() => {
            this.log.info("starting faucet drips...")
            this.blockFaucetDrips = false
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
        id: string | undefined,
        cb: (param: SendTokenResponse) => void
    ): Promise<void> {
        if(this.blockFaucetDrips) {
            cb({ status: 400, message: "Faucet is getting started! Please try after sometime"})
            return
        }

        if (!this.web3.utils.isAddress(receiver)) {
            cb({ status: 400, message: "Invalid address! Please try again." })
            return
        }

        // do not accept any request if mempool limit reached
        if (this.requestCount >= MEMPOOL_LIMIT) {
            this.log.error(`Reached the mempool limit of ${MEMPOOL_LIMIT}`);
            cb({ status: 400, message: "High faucet usage! Please try after sometime" })
            return
        }

        // increasing request count before processing request
        this.requestCount++

        let amount: BN = this.DRIP_AMOUNT

        // If id is provided, then it is ERC20 token transfer, so update the amount
        if (id) {
            const erc20 = this.contracts.get(id)!;
            amount = calculateBaseUnit(erc20.dripAmount.toString(), erc20.decimals || 18)
        }

        const requestId = receiver + id + Math.random().toString()

        this.processRequest({ receiver, amount, id, requestId })

        // After transaction is being processed, the nonce will be available and txHash can be returned to user
        const waitingForNonce = setInterval(async () => {
            const nonce: number | undefined = this.hasNonce.get(requestId)
            if (nonce != undefined) {
                clearInterval(waitingForNonce)

                this.hasNonce.set(requestId, undefined)

                const { txHash } = await this.getTransaction(receiver, amount, nonce, id)

                if(txHash) {
                    cb({
                        status: 200,
                        message: `Transaction successful on ${this.NAME}!`,
                        txHash
                    })
                } else {
                    cb({
                        status: 400,
                        message: `Transaction failed on ${this.NAME}! Please try again.`
                    })
                }
            } else if(this.hasError.get(receiver) != undefined) {
                clearInterval(waitingForNonce)

                const errorMessage = this.hasError.get(receiver)!
                this.hasError.set(receiver, undefined)

                cb({
                    status: 400,
                    message: errorMessage
                })
            }
        }, 300)
    }

    async processRequest(req: RequestType): Promise<void> {
        if (this.isRecalibrating) {
            this.waitArr.push(req)
        } else {
            this.putInQueue(req)
        }
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

            while (this.waitArr.length != 0) {
                this.putInQueue(this.waitArr.shift()!);
            }
        } catch(err: any) {
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

    async putInQueue(req: RequestType): Promise<void> {
        // this will prevent recalibration if it's started after calling putInQueue() function
        this.queuingInProgress = true

        // checking faucet balance before putting request in queue
        if (this.balanceCheck(req)) {
            this.queue.push({ ...req, nonce: this.nonce })
            this.hasNonce.set(req.requestId!, this.nonce)
            this.nonce++

            const { amount, receiver, nonce, id } = this.queue.shift()!;
            this.sendTokenUtil(amount, receiver, nonce, id)
        } else {
            this.queuingInProgress = false
            this.requestCount--
            this.log.warn("Faucet balance too low! " + req.id + " " + this.getBalance(req.id))
            this.hasError.set(req.receiver, "Faucet balance too low! Please try after sometime.")
        }
    }

    async sendTokenUtil(
        amount: BN,
        receiver: string,
        nonce: number,
        id?: string
    ): Promise<void> {
        // adding pending tx nonce in a set to prevent recalibration
        this.pendingTxNonces.add(nonce)

        // request from queue is now moved to pending txs list
        this.queuingInProgress = false

        const { rawTransaction } = await this.getTransaction(receiver, amount, nonce, id)

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
        } catch (err: any) {
            this.log.error(err.message)
        } finally {
            this.pendingTxNonces.delete(nonce)
            this.requestCount--
        }
    }

    async getTransaction(
        to: string,
        value: BN,
        nonce: number | undefined,
        id?: string
    ): Promise<any> {
        const tx: any = {
            type: 2,
            gas: "21000",
            nonce,
            to,
            maxPriorityFeePerGas: this.MAX_PRIORITY_FEE,
            maxFeePerGas: this.MAX_FEE,
            value
        }

        if (this.LEGACY) {
            delete tx["maxPriorityFeePerGas"]
            delete tx["maxFeePerGas"]
            tx.gasPrice = await this.getAdjustedGasPrice()
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

        let signedTx
        try {
            signedTx = await this.account.signTransaction(tx)
        } catch(err: any) {
            this.error = true
            this.log.error(err.message)
        }
        const txHash = signedTx?.transactionHash
        const rawTransaction = signedTx?.rawTransaction

        return { txHash, rawTransaction }
    }
    // get expected price from the network for legacy txs
    async getAdjustedGasPrice(): Promise<number> {
        try {
            const gasPrice: number = new BN(await this.web3.eth.getGasPrice()).toNumber();
            const adjustedGas: number = Math.floor(gasPrice * 1.25)
            return Math.min(adjustedGas, parseInt(this.MAX_FEE))
        } catch(err: any) {
            this.error = true
            this.log.error(err.message)
            return 0
        }
    }

    async recalibrateNonceAndBalance(): Promise<void> {
        if (this.isRecalibrating) {
            return;
        }

        const nowTimestamp = Date.now();
        const isTimeToRecalibrate = (nowTimestamp - this.lastRecalibrationTimestamp) / 1000 > this.RECALIBRATE;

        if (this.pendingTxNonces.size === 0 && !this.queuingInProgress && isTimeToRecalibrate) {
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

    getFaucetUsage(): number {
        return 100 * (this.requestCount / MEMPOOL_LIMIT)
    }
}