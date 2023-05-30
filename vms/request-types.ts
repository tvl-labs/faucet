import BN from "bn.js";

/**
 * Request statuses:
 * - mem-pool — just added to the queue
 * - queueing — transaction is being processed
 * - sent — transaction has been sent to RPC
 * - error — transaction failed
 */
export type RequestStatus = {
  type: 'mem-pool',
  request: RequestType
} | {
  type: 'queueing',
  request: RequestType
} | {
  type: 'error',
  errorMessage: string
} | {
  type: 'sent',
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