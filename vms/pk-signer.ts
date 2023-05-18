import { EvmSigner } from './signer';
import Web3 from 'web3';
import { Account, TransactionConfig } from 'web3-core';
import { ChainType } from '../types';

export class PkSigner implements EvmSigner {
  constructor(
    public web3: Web3,
    private account: Account,
    public address: string
  ) {
  }

  static create(config: ChainType, privateKey: string): PkSigner {
    const web3 = new Web3(config.RPC);
    const account = web3.eth.accounts.privateKeyToAccount(privateKey)
    const address = account.address;
    return new PkSigner(web3, account, address);
  }

  async signTransaction(transactionConfig: TransactionConfig): Promise<{
    txHash: string,
    rawTransaction: string
  }> {
    const signedTransaction = await this.account.signTransaction(transactionConfig);
    const txHash = signedTransaction.transactionHash!;
    const rawTransaction = signedTransaction.rawTransaction!;
    return { txHash, rawTransaction };
  }
}