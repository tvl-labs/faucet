import express, { Express, Router } from 'express'
import cors from 'cors'
import path from 'path'
import dotenv from 'dotenv'

import { parseBody, parseURI, RateLimiter, VerifyCaptcha } from './middlewares'
import EVM from './vms/evm'

import { ChainType, ConfigFileType, ERC20Type } from './vms/config-types'

import * as fs from 'fs';
import { PkSigner } from './vms/pk-signer';
import { EvmSigner } from './vms/signer';
import { KmsEvmSigner } from './vms/kms-signer';
import { prometheusRegistry } from './vms/metrics';
import { getRequestIp } from './middlewares/ip-utils';
import Log from './vms/log';

dotenv.config()

function readConfigFile(): ConfigFileType {
    const configPath = process.env.CONFIG_FILE ?? './config.json';
    console.log(`Reading config file from ${configPath}`);
    const configFile: ConfigFileType = JSON.parse(
      fs.readFileSync(configPath, 'utf-8')
    );
    configFile.evmchains.forEach((chain) => {
        const rpcEnvName = `EVM_CHAINS_${chain.ID}_RPC`;
        const overrideRpc = process.env[rpcEnvName];
        if (overrideRpc) {
            chain.RPC = overrideRpc;
        }
    });
    return configFile;
}

// Get the complete config object from the array of config objects (chains) with ID as id
function getChainByID(chains: ChainType[], id: string): ChainType | undefined {
    let reply: ChainType | undefined
    chains.forEach((chain: ChainType): void => {
        if (chain.ID == id) {
            reply = chain
        }
    })
    return reply
}

// Populates the missing config keys of the child using the parent's config
function populateConfig(child: any, parent: any): any {
    Object.keys(parent || {}).forEach((key) => {
        if (!child[key]) {
            child[key] = parent[key]
        }
    })
    return child
}

function configureApp(configFile: ConfigFileType): { app: Express, router: Router } {
    const app: Express = express()
    const router = express.Router()

    app.use(express.static(path.join(__dirname, "client")))
    app.use(cors())
    app.use(parseURI)
    app.use(parseBody)

    new RateLimiter(app, [configFile.GLOBAL_RL])

    new RateLimiter(app, [
        ...configFile.evmchains,
        ...configFile.erc20tokens
    ])

    // address rate limiter
    new RateLimiter(app, [
        ...configFile.evmchains,
        ...configFile.erc20tokens
    ], (req: any, _: any) => {
        const addr = req.body?.address

        if(typeof addr == "string" && addr) {
            return addr.toUpperCase()
        }
    })
    return { app, router };
}

async function configureEvmMap(configFile: ConfigFileType): Promise<Map<string, EVM>> {
    const evmMap = new Map<string, EVM>()

    // Setting up instance for EVM chains
    for (const chain of configFile.evmchains) {
        const pk = (process.env[chain.ID] || process.env.PK);
        const log = new Log(chain.NAME);
        let evmSigner: EvmSigner;
        if (pk) {
            evmSigner = await PkSigner.create(chain, pk);
        } else {
            const awsRegion = process.env["AWS_REGION"]!;
            const kmsKeyId = process.env[`AWS_KMS_KEY_${chain.ID}`]!;
            evmSigner = await KmsEvmSigner.create(chain.ID, chain.RPC, awsRegion, kmsKeyId, log);
            console.log(`Created Web3 KMS provider with address ${evmSigner.address} for chain ${chain.NAME}`);
        }
        const evm = new EVM(chain, evmSigner, log);
        await evm.start(false);
        evmMap.set(chain.ID, evm);
    }

    // Adding ERC20 token contracts to their HOST evm instances
    configFile.erc20tokens.forEach((token: ERC20Type, i: number): void => {
        const chain = getChainByID(configFile.evmchains, token.HOSTID)!;
        token = populateConfig(token, chain);
        configFile.erc20tokens[i] = token;
        const evm = evmMap.get(chain.ID)!
        evm.addERC20Contract(token)
    })

    return evmMap;
}

function prepareRoutes(
  app: Express,
  router: Router,
  evmMap: Map<string, EVM>,
  configFile: ConfigFileType
) {
    // POST request for sending tokens or coins
    const sendTokenHandlers = [];
    if (process.env.DISABLE_CAPTCHA === 'true') {
        console.log('Server will not be verifying captcha');
    } else {
        const captcha = new VerifyCaptcha(app, process.env.CAPTCHA_SECRET!, process.env.V2_CAPTCHA_SECRET!)
        sendTokenHandlers.push(captcha.middleware);
    }
    sendTokenHandlers.push(async (req: any, res: any) => {
        const address: string = req.body?.address
        const chain: string = req.body?.chain
        let erc20: string | undefined = req.body?.erc20

        const evm = evmMap.get(chain);
        if (!evm) {
            res.status(400).send({ message: "Invalid parameters passed!" })
            return;
        }

        if (erc20 && !evm.contracts.has(erc20)) {
            // TODO: Workaround for frontend bug: it sends ERC20 for the native token.
            //  Needs to be fixed on frontend. Probably the issue is that /getChainConfigs
            erc20 = undefined;
        }

        const { status, message, txHash } = await evm.sendToken(address, erc20);
        res.status(status).send({ message, txHash })
    });
    router.post('/sendToken', sendTokenHandlers)

    // GET request for fetching all the chain configurations
    router.get('/getChainConfigs', (req: any, res: any) => 
        res.send(configFile.evmchains)
    )

    // GET request for fetching all the token configurations
    router.get('/getTokenConfigs', (req: any, res: any) => 
        res.send(configFile.erc20tokens)
    )

    // GET request for fetching faucet address for the specified chain
    router.get('/faucetAddress', (req: any, res: any) => {
        const chain: string = req.query?.chain
        const evm = evmMap.get(chain);
        const address = evm?.address;
        res.send({ address })
    })

    // GET request for fetching faucet balance for the specified chain or token
    router.get('/getBalance', (req: any, res: any) => {
        const chain: string = req.query?.chain
        const id: string | undefined = req.query?.erc20
        const evm = evmMap.get(chain);
        if (!evm) {
            res.status(400).send({ message: `No chain found ${chain}!` })
            return;
        }

        const balance = evm.getBalance(id);
        res.status(200).send({
            balance: balance.toString()
        })
    })

    app.get('/metrics', async (req: any, res: any) => {
        res.set('Content-Type', prometheusRegistry.contentType);
        res.end(await prometheusRegistry.metrics());
    });

    app.use('/api', router)

    app.get('/health', (req: any, res: any) => {
        res.status(200).send('Server healthy')
    })

    app.get('/ip', (req: any, res: any) => {
        res.status(200).send({
            ip: getRequestIp(req),
            headers: req.headers
        })
    })

    app.get('*', async (req: any, res: any) => {
        res.sendFile(path.join(__dirname, "client", "index.html"))
    })
}

async function main() {
    const configFile = readConfigFile();
    const { app, router } = configureApp(configFile);
    const evmMap = await configureEvmMap(configFile);
    prepareRoutes(app, router, evmMap, configFile);
    app.listen(process.env.PORT || 8000, () => {
        console.log(`Server started at port ${process.env.PORT || 8000}`)
    })
}

main().catch(console.error);