import Decimal from 'decimal.js';

/**
 * Thin, dependency-isolated wrapper over `decimal.js`. The cost-basis engine
 * does all lot/disposal arithmetic through these helpers so that repeated
 * multiply/divide/subtract chains (cost-per-unit × amount, running remainders)
 * don't accumulate binary-floating-point error the way raw `number` math does.
 *
 * Keep this module tiny and side-effect free: it is the single place the rest
 * of `costBasis/*` imports `decimal.js` from, so a future swap of the underlying
 * big-decimal library only touches this file.
 */

export type DecimalInput = Decimal.Value;

/** Coerce any numeric-ish input into a Decimal. `null`/`undefined`/NaN → 0. */
export function D(x: DecimalInput | null | undefined): Decimal {
  if (x === null || x === undefined) return new Decimal(0);
  if (typeof x === 'number' && !Number.isFinite(x)) return new Decimal(0);
  return new Decimal(x);
}

export function add(a: DecimalInput, b: DecimalInput): Decimal {
  return D(a).plus(D(b));
}

export function sub(a: DecimalInput, b: DecimalInput): Decimal {
  return D(a).minus(D(b));
}

export function mul(a: DecimalInput, b: DecimalInput): Decimal {
  return D(a).times(D(b));
}

export function div(a: DecimalInput, b: DecimalInput): Decimal {
  const divisor = D(b);
  if (divisor.isZero()) return new Decimal(0);
  return D(a).dividedBy(divisor);
}

/** Convert a Decimal (or numeric-ish input) back to a plain JS number. */
export function toNumber(x: DecimalInput | null | undefined): number {
  return D(x).toNumber();
}

/**
 * Single dust threshold for the whole cost-basis engine, replacing the
 * scattered `1e-12` / `1e-9` / bare `0` comparisons that used to live in the
 * engine and strategies. Any remaining/consumable quantity at or below this
 * is treated as fully consumed (no phantom lot, no phantom shortfall).
 */
export const DUST = 1e-9;

/** True when |x| is at or below the shared DUST threshold. */
export function isDust(x: DecimalInput): boolean {
  return D(x).abs().lessThanOrEqualTo(DUST);
}

/** True when x is meaningfully greater than zero (strictly above DUST). */
export function isPositive(x: DecimalInput): boolean {
  return D(x).greaterThan(DUST);
}
