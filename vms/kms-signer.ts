import { ChainType } from '../types';
import { KmsProvider } from 'aws-kms-provider';
import Web3 from 'web3';
import { EvmSigner } from './signer';
import { TransactionConfig } from 'web3-core';
import { keccak256 } from 'web3-utils';

export class KmsEvmSigner implements EvmSigner {

  constructor(
    public web3: Web3,
    public address: string
  ) {
  }

  static async create(config: ChainType): Promise<KmsEvmSigner> {
    const awsRegion = process.env["AWS_REGION"]!;
    const kmsKeyId = process.env[`AWS_KMS_KEY_${config.ID}`]!;
    const provider = new KmsProvider(config.RPC, { keyIds: [kmsKeyId], region: awsRegion });
    const addresses = await provider.getAccounts();
    const address = addresses[0];
    console.log(`Creating Web3 KMS provider with address ${address}`);
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
