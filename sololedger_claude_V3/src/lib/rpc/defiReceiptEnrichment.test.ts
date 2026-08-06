import { describe, expect, it } from 'vitest';
import type { NeutralDefiAction } from '@/lib/defi/types';
import type { Transaction } from '@/types/transaction';
import { deriveTransactionPostings } from '@/lib/ledger/derivedPostings';
import { enrichEthereumDefiTransactions, materializeExactDefiActions } from './defiReceiptEnrichment';

const wallet = `0x${'1'.repeat(40)}`;
const pool = '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2';
const reserve = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const protocolToken = '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c';
const debtToken = '0x72e95b8931767c79ba4eee721354d6e99a61d004';

function interestAction(kind: 'lending' | 'borrowing', hash = '0xabc'): NeutralDefiAction {
  const token = kind === 'lending' ? protocolToken : debtToken;
  const role = kind === 'lending' ? 'protocol_token' as const : 'debt_token' as const;
  const callId = `event:1:${hash}:${token}:1`;
  const mintId = `event:1:${hash}:${token}:2`;
  return {
    type: 'interest', interestKind: kind, chainId: 1, protocolId: 'aave-v3-ethereum',
    reserveKey: reserve, quantity: '125000', transactionHash: hash, callId,
    eventIds: [callId, mintId], complete: true, confidence: 1, evidenceSource: 'ethereum_log',
    ruleId: `defi-receipt:aave-v3-ethereum:${kind}-interest`, ruleVersion: 'b5.1',
    callEvidence: { provider: 'blockscout', from: wallet, to: pool, status: 'success' },
    postingAnchorEventId: mintId,
    economicLegs: [{
      eventId: mintId, kind: role, direction: 'mint', contractAddress: token,
      quantity: '125000', from: `0x${'0'.repeat(40)}`, to: wallet
    }],
    registryEvidence: [{
      contractAddress: token, protocolId: 'aave-v3-ethereum', reserveKey: reserve, role
    }]
  };
}

function representedMint(action: NeutralDefiAction): Transaction {
  const leg = action.economicLegs![0];
  return {
    id: `mint-${action.interestKind}`, timestamp: 1, type: 'transfer_in', asset: 'aUSDC', amount: 0.125,
    fiatCurrency: 'USD', source: 'rpc:moralis', sourceRef: `moralis:${leg.eventId}`,
    txHash: action.transactionHash, walletAddress: wallet, counterpartyAddress: leg.from,
    contractAddress: leg.contractAddress, chain: 'ethereum', flags: ['possible_internal_transfer', 'needs_review'],
    isInternalTransfer: false,
    onchainTransferEvent: {
      chain: 'ethereum', txHash: action.transactionHash, assetKey: leg.contractAddress,
      indexKind: 'log', index: '2', sender: leg.from!, recipient: wallet, quantity: leg.quantity
    },
    raw: { token: { decimals: '6' }, defiActionEvidence: { complete: false, evidenceSource: 'moralis' } }
  };
}

describe('provider-independent exact DeFi materialization', () => {
  it.each(['lending', 'borrowing'] as const)('suppresses mapped mint custody and synthesizes %s interest', (kind) => {
    const action = interestAction(kind);
    const result = materializeExactDefiActions([representedMint(action)], [action]);
    expect(result.suppressedEvidenceLegs).toBe(1);
    expect(result.transactions).toHaveLength(1);
    const [row] = result.transactions;
    expect(row).toMatchObject({
      asset: 'USDC', amount: 0.125, contractAddress: reserve,
      type: kind === 'lending' ? 'income' : 'fee',
      category: kind === 'lending' ? 'lending_interest' : 'loan_fee',
      raw: { syntheticDefiComponent: true, defiActionEvidence: {
        postingAnchor: true, postingAnchorRawQuantity: '125000', postingAnchorDecimals: 6
      } }
    });
    expect(row.type === 'transfer_in' && row.category === 'loan_fee').toBe(false);
    const postings = deriveTransactionPostings(row, { exchangeConnections: [] });
    if (kind === 'borrowing') {
      expect(postings.map((posting) => [posting.role, posting.signedQuantity])).toEqual([['liability', -0.125]]);
    } else {
      expect(postings.map((posting) => [posting.role, posting.signedQuantity])).toEqual([['principal', 0.125]]);
    }
  });

  it('binds interest by postingAnchorEventId when Transfer quantity differs from balanceIncrease', () => {
    const action = interestAction('borrowing');
    action.quantity = '12';
    action.economicLegs![0].quantity = '100';
    const represented = representedMint(action);
    represented.amount = 0.0001;
    represented.onchainTransferEvent!.quantity = '100';

    const result = materializeExactDefiActions([represented], [action]);

    expect(result).toMatchObject({ enriched: 1, suppressedEvidenceLegs: 1, materializationFailed: 0 });
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]).toMatchObject({
      amount: 0.000012,
      raw: { defiActionEvidence: { postingAnchorRawQuantity: '12', postingAnchorEventId: action.postingAnchorEventId } }
    });
  });

  it('infers non-hardcoded reserve decimals from represented Transfer base units and display amount', () => {
    const action = interestAction('borrowing');
    const unknownReserve = `0x${'9'.repeat(40)}`;
    action.reserveKey = unknownReserve;
    action.quantity = '12000000';
    action.registryEvidence![0].reserveKey = unknownReserve;
    action.economicLegs![0].quantity = '100000000';
    const represented = representedMint(action);
    represented.amount = 1;
    represented.raw = {};
    represented.onchainTransferEvent!.quantity = '100000000';

    const result = materializeExactDefiActions([represented], [action]);

    expect(result).toMatchObject({ enriched: 1, materializationFailed: 0 });
    expect(result.transactions[0]).toMatchObject({
      amount: 0.12, contractAddress: unknownReserve,
      raw: { defiActionEvidence: { postingAnchorDecimals: 8, postingAnchorRawQuantity: '12000000' } }
    });
  });

  it('reconstructs 18 decimals for one raw unit represented as 1e-18', () => {
    const action = interestAction('borrowing');
    action.quantity = '1';
    action.economicLegs![0].quantity = '1';
    const represented = representedMint(action);
    represented.amount = 1e-18;
    represented.raw = {};
    represented.onchainTransferEvent!.quantity = '1';

    const result = materializeExactDefiActions([represented], [action]);

    expect(result).toMatchObject({ enriched: 1, materializationFailed: 0 });
    expect(result.transactions[0]).toMatchObject({
      amount: 1e-18,
      raw: { defiActionEvidence: { postingAnchorDecimals: 18 } }
    });
  });

  it('rejects ambiguous dust instead of accepting it through an absolute tolerance floor', () => {
    const action = interestAction('borrowing');
    action.quantity = '1';
    action.economicLegs![0].quantity = '1';
    const represented = representedMint(action);
    represented.amount = 5.5e-13;
    represented.raw = {};
    represented.onchainTransferEvent!.quantity = '1';

    const result = materializeExactDefiActions([represented], [action]);

    expect(result).toMatchObject({ enriched: 0, suppressedEvidenceLegs: 0, materializationFailed: 1 });
    expect(result.transactions).toEqual([represented]);
  });

  it('fails closed and retains represented evidence when synthesis cannot determine decimals', () => {
    const action = interestAction('lending');
    const represented = representedMint(action);
    represented.onchainTransferEvent = { ...represented.onchainTransferEvent!, index: '3' };

    const result = materializeExactDefiActions([represented], [action]);

    expect(result).toMatchObject({ enriched: 0, suppressedEvidenceLegs: 0, materializationFailed: 1 });
    expect(result.transactions).toEqual([represented]);
  });

  it('keeps incomplete Moralis labels as suggestions when no exact receipt action is available', async () => {
    const row = representedMint(interestAction('lending'));
    row.categoryOrigin = 'suggestion';
    const result = await enrichEthereumDefiTransactions([row], async () => []);
    expect(result.transactions).toEqual([row]);
    expect(result.transactions[0].categoryOrigin).toBe('suggestion');
  });

  it('bounds receipt concurrency and surfaces timeout diagnostics', async () => {
    const rows = Array.from({ length: 5 }, (_, index) => {
      const action = interestAction('lending', `0xabc${index}`);
      const row = representedMint(action);
      row.raw = { defiActionEvidence: { complete: false, evidenceSource: 'moralis' } };
      return row;
    });
    let active = 0;
    let maxActive = 0;
    const result = await enrichEthereumDefiTransactions(rows, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active--;
      return [];
    }, { concurrency: 2, timeoutMs: 5 });
    expect(maxActive).toBe(2);
    expect(result.diagnostics).toMatchObject({ candidates: 5, timedOut: 5, partial: true });
  });

  it.each([
    ['receipt_not_found', 'notFound'],
    ['receipt_http:503', 'httpFailed'],
    ['receipt_network:offline', 'networkFailed'],
    ['receipt_malformed:logs', 'malformed']
  ] as const)('preserves explicit %s scheduler outcomes', async (message, counter) => {
    const row = representedMint(interestAction('lending'));
    const result = await enrichEthereumDefiTransactions([row], async () => {
      throw new Error(message);
    });
    expect(result.diagnostics).toMatchObject({ failed: 1, [counter]: 1, partial: true });
    expect(result.transactions).toEqual([row]);
  });

  it('ignores bindings that resolve after the scheduler deadline and never mutates source rows', async () => {
    const row = representedMint(interestAction('lending'));
    const lateBinding = { ...row, type: 'income' as const, notes: 'late mutation must not apply' };
    const result = await enrichEthereumDefiTransactions([row], async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { actions: [], bindings: [lateBinding] };
    }, { timeoutMs: 5 });

    expect(result.diagnostics).toMatchObject({ timedOut: 1, partial: true });
    expect(result.transactions).toEqual([row]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(row.type).toBe('transfer_in');
    expect(row.notes).toBeUndefined();
    expect(result.transactions).toEqual([row]);
  });
});
