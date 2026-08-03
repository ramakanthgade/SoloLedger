import { describe, expect, it } from 'vitest';
import { supportsSpecificIdEditing } from './specificIdEditing';

describe('supportsSpecificIdEditing', () => {
  it('supports both direct sales and trade/swap disposals', () => {
    expect(supportsSpecificIdEditing('sell', 'SpecID')).toBe(true);
    expect(supportsSpecificIdEditing('trade', 'SpecID')).toBe(true);
  });
  it('does not expose the editor for acquisitions or non-SpecID methods', () => {
    expect(supportsSpecificIdEditing('buy', 'SpecID')).toBe(false);
    expect(supportsSpecificIdEditing('trade', 'FIFO')).toBe(false);
  });
});
