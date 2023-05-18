import { EvmSigner } from './signer';
import Web3 from 'web3';
import { Account, SignedTransaction, TransactionConfig } from 'web3-core';

export class PkSigner implements EvmSigner {
  constructor(
    public web3: Web3,
    private account: Account,
    public address: string
  ) {
  }

  static create(rpcUrl: string, privateKey: string) {
    const web3 = new Web3(rpcUrl);
    const account = web3.eth.accounts.privateKeyToAccount(privateKey)
    const address = account.address;
    return new PkSigner(web3, account, address);
  }

  signTransaction(
    transactionConfig: TransactionConfig,
    callback: ((signTransaction: SignedTransaction) => void) | undefined
  ): Promise<SignedTransaction> {
    return this.account.signTransaction(transactionConfig, callback);
  }
}