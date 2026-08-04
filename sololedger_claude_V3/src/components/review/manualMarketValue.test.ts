import { describe, expect, it } from 'vitest';
import { parseManualMarketValue } from './manualMarketValue';

describe('parseManualMarketValue', () => {
  it.each(['', '   ', '\t\n'])('preserves absent blank input %j', (input) => {
    expect(parseManualMarketValue(input)).toBeUndefined();
  });

  it('accepts explicit zero after trimming', () => {
    expect(parseManualMarketValue(' 0 ')).toBe(0);
  });

  it.each(['bad', '-1', 'Infinity'])('rejects invalid value %j', (input) => {
    expect(parseManualMarketValue(input)).toBeUndefined();
  });
});
