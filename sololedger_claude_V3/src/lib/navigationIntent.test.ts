import { describe, expect, it } from 'vitest';
import { createNavigationIntent, normalizeSourceTarget, resolveSourceTarget } from './navigationIntent';

const cards = [
  { id: 'exchange:ex-1', kind: 'exchange-api' as const, exchange: { id: 'ex-1' } },
  { id: 'file:csv-1', kind: 'file' as const, csvImport: { id: 'csv-1' } },
  { id: 'wallet:one', kind: 'wallet' as const, walletRows: [{ chain: 'ethereum', address: '0xAbC' }] },
  { id: 'manual', kind: 'manual' as const }
];

describe('typed navigation intents', () => {
  it('resolves every source kind only by durable identity', () => {
    expect(resolveSourceTarget({ kind: 'exchange', connectionId: 'ex-1' }, cards)?.id).toBe('exchange:ex-1');
    expect(resolveSourceTarget({ kind: 'csv', importId: 'csv-1' }, cards)?.id).toBe('file:csv-1');
    expect(resolveSourceTarget({ kind: 'wallet', chain: 'ETH', address: ' 0xabc ' }, cards)?.id).toBe('wallet:one');
    expect(resolveSourceTarget({ kind: 'exchange', connectionId: 'missing' }, cards)).toBeUndefined();
  });

  it('normalizes wallet chain and address without changing non-wallet targets', () => {
    expect(normalizeSourceTarget({ kind: 'wallet', chain: 'ETH', address: ' 0xAbC ' }))
      .toEqual({ kind: 'wallet', chain: 'ethereum', address: '0xabc' });
    expect(normalizeSourceTarget({ kind: 'csv', importId: 'x' })).toEqual({ kind: 'csv', importId: 'x' });
  });

  it('gives back-to-back intents distinct acknowledgable ids', () => {
    const input = { destination: 'transactions' as const, transactionId: 't1', focus: 'transaction' as const };
    expect(createNavigationIntent(input).id).not.toBe(createNavigationIntent(input).id);
  });

  it('rejects invalid destination/tab/focus combinations at compile time', () => {
    // @ts-expect-error manual remediation is a Transactions filter, never Connections.
    createNavigationIntent({ destination: 'connections', target: { kind: 'manual', singletonId: 'manual' }, workspaceTab: 'overview', focus: { kind: 'none' } });
    // @ts-expect-error opening focus is only valid on reconciliation.
    createNavigationIntent({ destination: 'connections', target: { kind: 'exchange', connectionId: 'x' }, workspaceTab: 'overview', focus: { kind: 'opening', scopeId: 'exchange:x', accountClass: 'spot', assetKey: 'a', action: 'add' } });
    // @ts-expect-error reconciliation asset focus requires exact scope and account class.
    createNavigationIntent({ destination: 'connections', target: { kind: 'exchange', connectionId: 'x' }, workspaceTab: 'reconciliation', focus: { kind: 'asset', assetKey: 'a' } });
    // @ts-expect-error exact transaction navigation cannot also carry a filter.
    createNavigationIntent({ destination: 'transactions', transactionId: 't', filter: { sourceTarget: { kind: 'manual', singletonId: 'manual' } }, focus: 'transaction' });
    expect(true).toBe(true);
  });
});
