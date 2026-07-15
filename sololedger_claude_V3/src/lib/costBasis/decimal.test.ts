import { describe, it, expect } from 'vitest';
import { D, add, sub, mul, div, toNumber, DUST, isDust, isPositive } from './decimal';

describe('decimal wrapper', () => {
  it('coerces null/undefined/NaN to 0', () => {
    expect(toNumber(D(null))).toBe(0);
    expect(toNumber(D(undefined))).toBe(0);
    expect(toNumber(D(NaN))).toBe(0);
    expect(toNumber(D(Infinity))).toBe(0);
  });

  it('does exact base-10 arithmetic where float drifts', () => {
    // 0.1 + 0.2 !== 0.3 in float; decimal makes it exact.
    expect(toNumber(add(0.1, 0.2))).toBe(0.3);
    expect(0.1 + 0.2).not.toBe(0.3);
  });

  it('supports add/sub/mul/div', () => {
    expect(toNumber(add(1, 2))).toBe(3);
    expect(toNumber(sub(5, 3))).toBe(2);
    expect(toNumber(mul(4, 2.5))).toBe(10);
    expect(toNumber(div(10, 4))).toBe(2.5);
  });

  it('returns 0 for division by zero instead of Infinity', () => {
    expect(toNumber(div(1, 0))).toBe(0);
  });

  it('DUST threshold classifies dust vs meaningful quantities', () => {
    expect(DUST).toBe(1e-9);
    expect(isDust(1e-12)).toBe(true);
    expect(isDust(1e-9)).toBe(true);
    expect(isDust(-1e-12)).toBe(true);
    expect(isDust(1e-6)).toBe(false);
    expect(isPositive(1e-6)).toBe(true);
    expect(isPositive(1e-12)).toBe(false);
    expect(isPositive(0)).toBe(false);
  });
});
