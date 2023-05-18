import Web3 from 'web3';
import { SignedTransaction, TransactionConfig } from 'web3-core';

export interface EvmSigner {
  web3: Web3;

  address: string;

  signTransaction: (
    transactionConfig: TransactionConfig,
    callback?: (signTransaction: SignedTransaction) => void
  ) => Promise<SignedTransaction>;
}