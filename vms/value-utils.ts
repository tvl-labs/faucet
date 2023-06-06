import BN from "bn.js";

export function calculateBaseUnit(amount: BN, decimals: number): BN {
  for (let i = 0; i < decimals; i++) {
    amount = amount.mul(new BN(10));
  }
  return amount;
}

export function calculatePresentableUnit(amount: BN, decimals: number): number {
  const bn = amount.div(new BN(10).pow(new BN(decimals)));
  try {
    return bn.toNumber();
  } catch (e) {
    console.error(`Balance overflow: ${bn.toString()} with decimals ${decimals}`);
    return -1;
  }
}