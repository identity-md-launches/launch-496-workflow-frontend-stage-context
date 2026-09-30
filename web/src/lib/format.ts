import { formatUnits, getAddress, type Address } from 'viem';

/** Human-readable token amount with grouping and a bounded number of fraction digits. */
export function formatAmount(value: bigint | undefined, decimals: number, maxFraction = 4): string {
  if (value === undefined) return '—';
  const raw = formatUnits(value, decimals);
  const [whole, fraction = ''] = raw.split('.');
  const wholeFormatted = BigInt(whole).toLocaleString('en-US');
  const trimmed = fraction.slice(0, maxFraction).replace(/0+$/, '');
  if (!trimmed) {
    // Non-zero values that round to zero still show they are non-zero.
    if (value !== 0n && BigInt(whole) === 0n) return `<0.${'0'.repeat(Math.max(maxFraction - 1, 0))}1`;
    return wholeFormatted;
  }
  return `${wholeFormatted}.${trimmed}`;
}

export function shortAddress(address: string): string {
  const a = getAddress(address as Address);
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function shortHash(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

export function formatDateTime(unixSeconds: bigint | number): string {
  const d = new Date(Number(unixSeconds) * 1000);
  return d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatCountdown(untilUnixSeconds: bigint | number, nowMs = Date.now()): string {
  const remaining = Number(untilUnixSeconds) - Math.floor(nowMs / 1000);
  if (remaining <= 0) return 'expired';
  const h = Math.floor(remaining / 3600);
  const m = Math.floor((remaining % 3600) / 60);
  if (h > 0) return `${h} h ${m} min left`;
  return `${m} min left`;
}

/** Parses a decimal user input to base units; returns undefined for empty/invalid input. */
export function parseAmountInput(input: string, decimals: number): bigint | undefined {
  const s = input.trim().replace(/,/g, '');
  if (!/^\d*(\.\d*)?$/.test(s) || s === '' || s === '.') return undefined;
  const [whole = '0', fraction = ''] = s.split('.');
  if (fraction.length > decimals) return undefined;
  const padded = fraction.padEnd(decimals, '0');
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(padded || '0');
}

export function explorerAddressUrl(explorer: string | undefined, address: string): string | undefined {
  return explorer ? `${explorer.replace(/\/$/, '')}/address/${address}` : undefined;
}

export function explorerTxUrl(explorer: string | undefined, hash: string): string | undefined {
  return explorer ? `${explorer.replace(/\/$/, '')}/tx/${hash}` : undefined;
}

/** Price of currency1 in currency0 from a Uniswap sqrtPriceX96, as a decimal string. */
export function priceFromSqrtX96(sqrtPriceX96: bigint, decimals0: number, decimals1: number): { token1PerToken0: string; token0PerToken1: string } {
  // price1per0 = (sqrtP / 2^96)^2 * 10^(d0 - d1)
  const Q96 = 2n ** 96n;
  const SCALE = 10n ** 18n;
  const num = sqrtPriceX96 * sqrtPriceX96 * SCALE * 10n ** BigInt(decimals0);
  const den = Q96 * Q96 * 10n ** BigInt(decimals1);
  const p = num / den; // token1 per token0, scaled 1e18
  const inv = p === 0n ? 0n : (SCALE * SCALE) / p;
  return { token1PerToken0: formatAmount(p, 18, 6), token0PerToken1: formatAmount(inv, 18, 8) };
}
