import BN from "bn.js";

export function calculateBaseUnit(amount: string, decimals: number): BN {
  for (let i = 0; i < decimals; i++) {
    amount += "0"
  }

  return new BN(amount)
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