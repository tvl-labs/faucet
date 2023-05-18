# Khalani Tokens Faucet

Khalani Protocol connects multiple chains, and on each chain there are USD-like ERC-20 test tokens deployed.

This project provides a user-friendly faucet forked from [Avalanche Faucet](https://github.com/ava-labs/avalanche-faucet)
to allow users and external developers get some test tokens:
- Khalani Chain native token `KHA`
- Sepolia (`USDC` / `USDT`)
- Avalanche Fuji (`USDC` / `USDT`)
- Polygon Mumbai (`USDC` / `USDT`)
- BSC Testnet (`USDC` / `USDT` / `BUSD`)
- Arbitrum Goerli (`USDC` / `USDT`)
- Optimism Goerli (`USDC` / `USDT`)
- Godwoken (`USDC` / `USDT`)

![faucet.png](docs%2Ffaucet.png)

### Original fork changes
Compared to the original fork, this repository has several patches and improvement:
- significantly streamlined the state management of requests and nonce/balance recalibration
- added support of faucet wallet signer with [AWS KMS](https://docs.aws.amazon.com/kms/latest/APIReference/API_Sign.html)
- added Prometheus support
- allow to configure faucet from a file specified by `CONFIG_FILE`
- allow to override RPC URLs with ENV variables of name `EVM_CHAINS_${CHAIN_ID}_RPC` 
specified in `evmchains` of `config.json`, for example `EVM_CHAINS_KHALANITESTNET_RPC` — allows to move RPC URLs to mountable Kubernetes `Secret`s.
- allow to disable captcha verification — needed to test the deployment and then register Google Captcha for the production domain
- added Khalani Protocol branding (logo / docs)

### Prometheus metrics
Faucet exposes some useful Prometheus metrics on `/metrics`:
- `faucet_wallet_balance { chain, token_id, token_name, token_address, faucet_address } ` — current balance of the faucet wallet: amount of ERC20 (`token_name`/`token_address`) or native tokens (`token_name`/`token_address` = `"native"`) 
- `faucet_wallet_nonce { chain }` — nonce number of the faucet wallet used to order transactions
- `faucet_requests_processed { chain, status }` — Number of processed faucet requests 

### AWS KMS signer
KMS keys are configured with `AWS_KMS_KEY_${CHAIN_ID}` env variables. Global AWS region is configured with `AWS_REGION` env variable.

Faucet process must be [authenticated](https://docs.aws.amazon.com/sdk-for-javascript/v2/developer-guide/setting-credentials-node.html) to call KMS API
and be authorized to use the specified KMS keys. 

The recommend way of authorization is to use [Web Identity IAM roles](https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRoleWithWebIdentity.html).

### Development
First, prepare an `.env` file. Copy `.env.dist` to `.env` and set up the wallet key.

Run `npm install` then `npm run dev`.