import { BN } from 'avalanche'

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