import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Transaction } from '@/types/transaction';
import { buildHoldingsProjection } from '@/lib/portfolio/holdingsProjection';
import { materializeImportedTransactionSafety } from '@/lib/safety/assetSafety';
import { assetSubjectKey } from '@/lib/safety/canonicalAssets';
import { db, setTransactionSafetyVisibility } from './db';

const CONTRACT = '0x1111111111111111111111111111111111111111';

function transaction(id: string, index: number, withEvidence = false): Transaction {
  const safetySubjectKey = `event:ethereum:0x${index.toString(16)}:${CONTRACT}:${index}:in`;
  return {
    id,
    timestamp: 1_700_000_000_000 + index,
    type: 'buy',
    asset: id === 'flagged' ? 'TOK' : 'DIFFERENT',
    amount: 1,
    fiatCurrency: 'INR',
    fiatValue: 1_000,
    source: 'rpc:moralis',
    flags: [],
    isInternalTransfer: false,
    chain: 'ethereum',
    contractAddress: CONTRACT,
    txHash: `0x${index.toString(16)}`,
    safetySubjectKey,
    raw: withEvidence ? {
      safetyEvidence: [{
        id: 'provider-event', provider: 'moralis', ruleId: 'possible_spam',
        ruleVersion: '1', confidence: 0.95, observedAt: 100
      }]
    } : undefined
  };
}

describe('exact asset restore visibility', () => {
  beforeEach(async () => {
    await Promise.all([
      db.transactions.clear(),
      db.providerEvidence.clear(),
      db.safetyDecisions.clear()
    ]);
  });

  it('restores all applicable exact-contract rows and user precedence survives a later sync', async () => {
    const imported = materializeImportedTransactionSafety([
      transaction('flagged', 1, true),
      transaction('same-contract', 2)
    ]);
    await db.transactions.bulkPut(imported.transactions);
    await db.providerEvidence.bulkPut(imported.providerEvidence);
    await db.safetyDecisions.bulkPut(imported.automaticDecisions);

    const assetKey = assetSubjectKey('ethereum', CONTRACT);
    expect(await db.safetyDecisions.get(assetKey)).toMatchObject({
      state: 'high_confidence_spam', origin: 'automatic'
    });
    expect(await db.transactions.toArray()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'flagged', isSpam: true }),
      expect.objectContaining({ id: 'same-contract', isSpam: true })
    ]));

    await setTransactionSafetyVisibility((await db.transactions.get('flagged'))!, true, 200);
    expect(await db.safetyDecisions.get(assetKey)).toMatchObject({
      state: 'user_visible', origin: 'user', previousAutomaticState: 'high_confidence_spam'
    });
    expect(await db.transactions.toArray()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'flagged', safetyState: 'user_visible', isSpam: false }),
      expect.objectContaining({ id: 'same-contract', safetyState: 'user_visible', isSpam: false })
    ]));

    const restoredProjection = buildHoldingsProjection({
      transactions: await db.transactions.toArray(),
      safetyDecisions: await db.safetyDecisions.toArray(),
      exchangeConnections: [], openingBalances: [], snapshots: [], assets: [], coverage: [], now: 300
    });
    expect(restoredProjection.holdings).toEqual([
      expect.objectContaining({ quantity: 2, costBasis: 2_000, contractAddress: CONTRACT })
    ]);
    expect(restoredProjection.holdings.reduce((sum, row) => sum + row.costBasis, 0)).toBe(2_000);

    await setTransactionSafetyVisibility((await db.transactions.get('same-contract'))!, false, 250);
    const refreshed = materializeImportedTransactionSafety(
      [transaction('flagged', 1, true), transaction('same-contract', 2)],
      undefined,
      await db.safetyDecisions.toArray()
    );
    expect(refreshed.transactions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'flagged', safetyState: 'user_visible', isSpam: false }),
      expect.objectContaining({ id: 'same-contract', safetyState: 'user_hidden', isSpam: true })
    ]));
    expect(refreshed.automaticDecisions).toEqual([]);
    expect(refreshed.providerEvidence.map((row) => row.id)).toContain('provider-event');
  });
});
