import BN from "bn.js";

export function calculateBaseUnit(amount: number, decimals: number): BN {
  const base = new BN(10).pow(new BN(decimals));
  return base.muln(amount);
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