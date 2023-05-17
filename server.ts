import express, { Express, Router } from 'express'
import cors from 'cors'
import path from 'path'
import dotenv from 'dotenv'

import { parseBody, parseURI, RateLimiter, VerifyCaptcha } from './middlewares'
import EVM from './vms/evm'

import { ChainType, ConfigFileType, ERC20Type, SendTokenResponse } from './types'

import * as fs from 'fs';

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

async function configureEvms(configFile: ConfigFileType): Promise<Map<string, EVM>> {
    const evms = new Map<string, EVM>()

    // Setting up instance for EVM chains
    for (const chain of configFile.evmchains) {
        const evm = new EVM(chain, process.env[chain.ID] || process.env.PK);
        evms.set(chain.ID, evm);
    }

    // Adding ERC20 token contracts to their HOST evm instances
    configFile.erc20tokens.forEach((token: ERC20Type, i: number): void => {
        const chain = getChainByID(configFile.evmchains, token.HOSTID)!;
        token = populateConfig(token, chain);
        configFile.erc20tokens[i] = token;
        const evm = evms.get(chain.ID)!
        evm.addERC20Contract(token)
    })

    return evms;
}

function prepareRoutes(
  app: Express,
  router: Router,
  evms: Map<string, EVM>,
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
        const erc20: string | undefined = req.body?.erc20

        const evm = evms.get(chain);

        if (evm) {
            await evm.sendToken(address, erc20, (data: SendTokenResponse) => {
              const { status, message, txHash } = data
              res.status(status).send({ message, txHash })
            })
        } else {
            res.status(400).send({ message: "Invalid parameters passed!" })
        }
    });
    router.post('/sendToken', sendTokenHandlers)

    // GET request for fetching all the chain and token configurations
    router.get('/getChainConfigs', (req: any, res: any) => {
        const configs: any = [...configFile.evmchains, ...configFile.erc20tokens]
        res.send({ configs })
    })

    // GET request for fetching faucet address for the specified chain
    router.get('/faucetAddress', async (req: any, res: any) => {
        const chain: string = req.query?.chain
        const evm = evms.get(chain);
        const address = evm?.address;
        res.send({ address })
    })

    // GET request for fetching faucet balance for the specified chain or token
    router.get('/getBalance', (req: any, res: any) => {
        const chain: string = req.query?.chain
        const id: string | undefined = req.query?.erc20
        const evm = evms.get(chain);
        if (!evm) {
            res.status(400).send({ message: `No chain found ${chain}!` })
            return;
        }

        const balance = evm.getBalance(id);
        res.status(200).send({
            balance: balance.toString()
        })
    })

    router.get('/faucetUsage', (req: any, res: any) => {
        const chain: string = req.query?.chain

        const evm = evms.get(chain)!

        const usage: number = evm?.getFaucetUsage()

        res.status(200).send({
            usage
        })
    })

    app.use('/api', router)

    app.get('/health', (req: any, res: any) => {
        res.status(200).send('Server healthy')
    })

    app.get('/ip', (req: any, res: any) => {
        res.status(200).send({
            ip: req.headers["cf-connecting-ip"] || req.ip
        })
    })

    app.get('*', async (req: any, res: any) => {
        res.sendFile(path.join(__dirname, "client", "index.html"))
    })
}

async function main() {
    const configFile = readConfigFile();
    const { app, router } = configureApp(configFile);
    const evms = await configureEvms(configFile);
    prepareRoutes(app, router, evms, configFile);
    app.listen(process.env.PORT || 8000, () => {
        console.log(`Server started at port ${process.env.PORT || 8000}`)
    })
}

main().catch(console.error);