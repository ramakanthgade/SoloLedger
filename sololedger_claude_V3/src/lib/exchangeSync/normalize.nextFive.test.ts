import { describe, expect, it } from 'vitest';
import { normalizeTrade, normalizeTransfer } from './normalize';
import type { ExchangeId } from './types';
import { assignCoinspotTradeIds } from './nextFiveExchanges';

const market = { id: 'btcusdt', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', spot: true };

function trade(id: string | undefined) {
  return {
    id, timestamp: 1_700_000_000_123, symbol: 'BTC/USDT', side: 'buy', amount: 0.5, cost: 10_000,
    fee: { cost: 1, currency: 'USDT' }, info: {}
  };
}

describe('next-five normalization identity', () => {
  it.each(['bitrue', 'xt', 'phemex', 'lbank'] as const)('%s requires and retains native fill ids', (exchange) => {
    const normalized = normalizeTrade(exchange, trade('fill-1'), market);
    expect(normalized).toMatchObject({ source: `${exchange}_api`, type: 'buy' });
    expect(normalized?.sourceRef).toContain('fill-1');
    expect(normalizeTrade(exchange, trade(undefined), market)).toBeNull();
  });

  it('scopes Bitrue symbol-local fill ids by symbol', () => {
    expect(normalizeTrade('bitrue', trade('7'), market)?.sourceRef).toBe('BTC/USDT:7');
  });

  it('scopes Tokocrypto symbol-local fill ids by symbol', () => {
    expect(normalizeTrade('tokocrypto', trade('7'), market)?.sourceRef).toBe('BTC/USDT:7');
  });

  it('normalizes a recovered Tokocrypto withdrawal asset and fee', () => {
    expect(normalizeTransfer('tokocrypto', {
      id: '4245859', timestamp: 1_659_521_314_413, currency: 'BIDR', amount: 10_000,
      fee: { currency: 'BIDR', cost: 12.5 }, status: 'ok', type: 'withdrawal',
      info: { asset: 'BIDR', fee: '12.5' }
    }, 'withdrawal')).toMatchObject({
      source: 'tokocrypto_api', sourceRef: '4245859', asset: 'BIDR', feeAsset: 'BIDR', feeAmount: 12.5
    });
  });

  it('keeps CoinSpot API replay deterministic without claiming CSV identity', () => {
    const normalized = normalizeTrade('coinspot', assignCoinspotTradeIds([trade(undefined)])[0], market);
    expect(normalized).toMatchObject({ source: 'coinspot_api', type: 'buy' });
    expect(normalized?.sourceRef).toContain('coinspot-trade:');
    expect(normalized?.sourceRef).not.toContain('coinspot:');
  });

  it.each(['bitrue', 'xt', 'coinspot', 'phemex'] as ExchangeId[])(
    '%s transfer identity uses immutable endpoint evidence',
    (exchange) => {
      const normalized = normalizeTransfer(exchange, {
        id: 'wallet-1', timestamp: 1_700_000_000_000, currency: 'BTC', amount: 1,
        status: 'ok', type: 'deposit', info: { status: 'ok' }
      }, 'deposit');
      expect(normalized).toMatchObject({ source: `${exchange}_api`, sourceRef: 'wallet-1', type: 'transfer_in' });
    }
  );

  it('LBank scopes deposit txid fallback by direction and keeps withdrawal native id', () => {
    const common = { timestamp: 1_700_000_000_000, currency: 'BTC', amount: 1, status: 'ok' };
    expect(normalizeTransfer('lbank', { ...common, txid: 'hash', type: 'deposit', info: { status: '2' } }, 'deposit')?.sourceRef)
      .toBe('deposit:hash');
    expect(normalizeTransfer('lbank', { ...common, id: 'wallet-1', txid: 'hash', type: 'withdrawal', info: { status: '4' } }, 'withdrawal')?.sourceRef)
      .toBe('wallet-1');
  });
});
