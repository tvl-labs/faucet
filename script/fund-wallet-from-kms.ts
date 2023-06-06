import EVM from '../vms/evm';
import { KmsEvmSigner } from '../vms/kms-signer';
import Log from '../vms/log';
import { ChainType } from '../vms/config-types';
import chainsJson from './chains.json';

const log = new Log("transfer-funds-from-kms-key");

async function main() {
  const rpcUrl = process.env.RPC_URL as string;
  const awsRegion = process.env.AWS_REGION as string;
  const kmsKeyId = process.env.KMS_KEY_ID as string;
  const chainID = process.env.CHAIN_ID as string;
  const recipient = process.env.RECIPIENT as string;
  const amount = 1;
  const chains = chainsJson as ChainType[];
  const chain = chains.find((c) => c.ID === chainID);
  if (!chain) {
    throw new Error(`Unknown chain ${chainID}`);
  }
  const kmsSigner = await KmsEvmSigner.create(chain.ID, rpcUrl, awsRegion, kmsKeyId, log);
  const evm = new EVM({ ...chain, DRIP_AMOUNT: amount }, kmsSigner, log);
  await evm.start(true);
  const response = await evm.sendToken(recipient, undefined);
  if (response.status !== 200) {
    throw new Error(`Failed to send tokens: ${response.message})`);
  }
  log.info(`Successfully transferred ${amount} ${chain.TOKEN} to ${recipient}: ${chain.EXPLORER}/tx/${response.txHash}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
})