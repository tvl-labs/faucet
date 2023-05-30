import { Counter, Gauge, Registry } from "prom-client";

export const prometheusRegistry = new Registry();

export const requestsInProgressGauge = new Gauge({
  name: 'faucet_requests_in_progress',
  help: 'Number of faucet requests being processed',
  registers: [prometheusRegistry],
  labelNames: [
    'chain'
  ],
});

export const requestsProcessedCounter = new Counter({
  name: 'faucet_requests_processed',
  help: 'Number of processed faucet requests',
  registers: [prometheusRegistry],
  labelNames: [
    'chain',
    'status'
  ],
});

export const balanceGauge = new Gauge({
  name: 'faucet_wallet_balance',
  help: 'Current balance of the faucet wallet: amount of ERC20 (token_name/token_address) or native tokens (token_name/token_address = "native")',
  registers: [prometheusRegistry],
  labelNames: [
    'chain',
    'token_id',
    'token_name',
    'token_address',
    'faucet_address'
  ],
});

prometheusRegistry.registerMetric(balanceGauge);