import { ChainType } from './config-types';
import { KmsProvider } from 'aws-kms-provider';
import Web3 from 'web3';
import { EvmSigner } from './signer';
import { TransactionConfig } from 'web3-core';
import { keccak256 } from 'web3-utils';
import Log from './log';

export class KmsEvmSigner implements EvmSigner {

  constructor(
    public web3: Web3,
    public address: string
  ) {
  }

  static async create(
    chainID: string,
    rpcUrl: string,
    awsRegion: string,
    kmsKeyId: string,
    log: Log
  ): Promise<KmsEvmSigner> {
    const provider = new KmsProvider(rpcUrl, { keyIds: [kmsKeyId], region: awsRegion });
    // Workaround for https://github.com/odanado/cloud-cryptographic-wallet/issues/845
    const engine = (provider as any).engine;
    engine.on('error', (e?: any) => log.error(`An error occurred in HTTP provider of ${chainID}: ${e}`));
    const addresses = await provider.getAccounts();
    const address = addresses[0];
    console.log(`Creating Web3 KMS provider with address ${address} for chain ${chainID}`);
    const web3 = new Web3(provider);
    return new KmsEvmSigner(web3, address);
  }

  async signTransaction(transactionConfig: TransactionConfig): Promise<{ txHash: string; rawTransaction: string }> {
    const rlpEncodedTransaction = await this.web3.eth.signTransaction(transactionConfig);
    const rawTransaction = rlpEncodedTransaction.raw;
    const txHash = keccak256(rawTransaction);
    return { txHash, rawTransaction };
  }
}
