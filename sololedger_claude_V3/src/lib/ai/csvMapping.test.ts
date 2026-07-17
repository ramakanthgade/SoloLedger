import { describe, it, expect, vi, beforeEach } from 'vitest';
import { suggestCsvMappingWithAi } from './csvMapping';

// Mock the OpenRouter call so we control the AI's raw JSON response.
vi.mock('@/lib/ai/openrouter', () => ({
  completeChat: vi.fn(),
  DEFAULT_AI_MODEL: 'test/model'
}));

import { completeChat } from '@/lib/ai/openrouter';

const HEADERS = ['When', 'Side', 'Ticker', 'Qty', 'Total'];
const SAMPLE = [{ When: '2025-01-01', Side: 'buy', Ticker: 'BTC', Qty: '1', Total: '50000' }];

describe('AI CSV mapping validation gate (C1)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns valid=true with no missing fields when all required columns map', () => {
    vi.mocked(completeChat).mockResolvedValue(
      JSON.stringify({
        timestamp: 'When',
        type: 'Side',
        asset: 'Ticker',
        amount: 'Qty',
        totalValue: 'Total',
        typeValueMap: { buy: 'buy', sell: 'sell' },
        confidence: 'high'
      })
    );
    return suggestCsvMappingWithAi('key', HEADERS, SAMPLE).then((res) => {
      expect(res.valid).toBe(true);
      expect(res.missingFields).toEqual([]);
      expect(res.mapping.timestamp).toBe('When');
    });
  });

  it('reports missing required fields instead of falling back to headers[0]', () => {
    vi.mocked(completeChat).mockResolvedValue(
      JSON.stringify({
        timestamp: 'When',
        // type + asset unresolved (AI returned nonsense / null)
        type: 'NoSuchColumn',
        asset: null,
        amount: 'Qty',
        typeValueMap: {},
        confidence: 'low'
      })
    );
    return suggestCsvMappingWithAi('key', HEADERS, SAMPLE).then((res) => {
      expect(res.valid).toBe(false);
      expect(res.missingFields).toContain('type');
      expect(res.missingFields).toContain('asset');
      // No blind headers[0] fallback — unresolved fields are empty strings.
      expect(res.mapping.type).toBe('');
      expect(res.mapping.asset).toBe('');
      // The first header was NOT silently used for the missing fields.
      expect(res.mapping.type).not.toBe(HEADERS[0]);
    });
  });
});
