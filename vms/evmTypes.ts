import { BN } from 'avalanche'

export type TransactionStatus = {
    type: 'pending',
    txHash: string
} | {
    type: 'error',
    errorMessage: string
} | {
    type: 'confirmed',
    txHash: string
}

export type SendTokenResponse = {
    status: number,
    message: string,
    txHash?: string
}

export type RequestType = {
    receiver: string,
    amount: BN,
    id?: string,
    requestId: string,
}