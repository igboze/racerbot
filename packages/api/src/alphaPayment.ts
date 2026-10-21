export function splitAlphaKeyPayment(priceNear: number, platformPayout = false): {
  totalYocto: bigint;
  creatorYocto: bigint;
  treasuryYocto: bigint;
  creatorRevenueNear: number;
} {
  const priceCents = Math.round(priceNear * 100);
  if (!Number.isFinite(priceNear) || priceNear <= 0 || Math.abs(priceCents / 100 - priceNear) > 1e-8) {
    throw new Error('Viewing key price must be a positive amount with at most two decimal places.');
  }

  const totalYocto = BigInt(priceCents) * 10n ** 22n;
  const creatorYocto = platformPayout ? 0n : totalYocto * 95n / 100n;
  return {
    totalYocto,
    creatorYocto,
    treasuryYocto: totalYocto - creatorYocto,
    creatorRevenueNear: Number((priceNear * 0.95).toFixed(4)),
  };
}
