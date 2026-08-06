import { describe, expect, it } from 'vitest';
import type { Disposal, Lot, TaxSettings, Transaction } from '@/types/transaction';
import { defaultDerivativesTreatment } from '@/lib/tax/derivatives';
import { buildTransactionCostAnalysisIndexes, buildTransactionCostAnalysisModel } from './transactionCostAnalysisModel';
import type { InventoryDisposal } from '@/lib/costBasis/engine';

const tx: Transaction = { id: 'sell', timestamp: Date.UTC(2025, 0, 2), type: 'sell', asset: 'BTC', amount: 1, fiatCurrency: 'USD', fiatValue: 100, source: 'manual', flags: [], isInternalTransfer: false };
const buy: Transaction = { ...tx, id: 'buy', timestamp: Date.UTC(2024, 0, 1), type: 'buy', fiatValue: 60, source: 'coinbase' };
const lot: Lot = { id: 'lot', asset: 'BTC', acquiredAt: buy.timestamp, amountRemaining: 0, amountOriginal: 1, costBasisPerUnit: 60, costBasisTotal: 60, sourceTxId: buy.id, acquisitionType: 'buy' };
const disposal: Disposal = { id: 'd', asset: 'BTC', disposedAt: tx.timestamp, amount: 1, proceeds: 100, costBasis: 60, gain: 40, holdingPeriodDays: 367, lotConsumption: [{ lotId: lot.id, amount: 1, costBasis: 60 }], sourceTxId: tx.id, method: 'FIFO' };
const settings = (jurisdiction: TaxSettings['jurisdiction'], derivativesTreatment?: TaxSettings['derivativesTreatment']): TaxSettings => ({ jurisdiction, reportingCurrency: { IN: 'INR', US: 'USD', CA: 'CAD', AE: 'AED' }[jurisdiction], defaultCostBasisMethod: 'FIFO', derivativesTreatment, priceApiEnabled: false, rpcLookupEnabled: false });
const indexes = (transactions: Transaction[] = [buy, tx], disposals: Disposal[] = [disposal], lots: Lot[] = [lot], inventoryDisposals: InventoryDisposal[] = []) => buildTransactionCostAnalysisIndexes({ transactions, disposals, lots, inventoryDisposals });

describe('transaction cost analysis model', () => {
  it.each(['IN', 'US', 'CA', 'AE'] as const)('uses configured %s metadata and preindexed report-source gains', (jurisdiction) => {
    const model = buildTransactionCostAnalysisModel({ transaction: tx, settings: settings(jurisdiction), disposal, indexes: indexes() });
    expect(model.matchedRows).toMatchObject([{ proceeds: 100, costBasis: 60, gain: 40, sourceLabel: 'coinbase', acquisitionType: 'buy', unitCost: 60 }]);
    expect(model.yearConvention).toBe(jurisdiction === 'IN' ? 'financial year' : 'calendar year');
    expect(model.eventTreatment?.rawGain).toBe(40);
    if (jurisdiction === 'CA') expect(model.eventTreatment).toMatchObject({ taxableGain: 20, inclusionRate: 0.5 });
    else expect(model.eventTreatment?.taxableGain).toBe(40);
    if (jurisdiction === 'US') expect(model.eventTreatment).toMatchObject({ shortTermGain: 0, longTermGain: 40 });
  });
  it('applies India loss disallowance per event while keeping raw loss visible', () => {
    const lossDisposal = { ...disposal, proceeds: 40, costBasis: 60, gain: -20 };
    const lossTx = { ...tx, fiatValue: 40 };
    const model = buildTransactionCostAnalysisModel({ transaction: lossTx, settings: settings('IN'), disposal: lossDisposal, indexes: indexes([buy, lossTx], [lossDisposal]) });
    expect(model.eventTreatment).toMatchObject({ rawGain: -20, taxableGain: 0, disallowedLoss: 20 });
  });
  it('keeps proceeds and gain unknown while retaining known basis when unpriced', () => {
    const unpriced = { ...tx, fiatValue: undefined };
    const model = buildTransactionCostAnalysisModel({ transaction: unpriced, settings: settings('US'), disposal, indexes: indexes([buy, unpriced]) });
    expect(model).toMatchObject({ pricingStatus: 'unpriced', proceeds: undefined, costBasis: 60, gain: undefined });
    expect(model.matchedRows[0]).toMatchObject({ proceeds: undefined, costBasis: 60, gain: undefined, unitCost: 60 }); expect(model.warnings.join(' ')).toContain('not finalized');
  });
  it('shows known inventory lot consumption and basis for a fully matched unpriced disposal', () => {
    const unpriced = { ...tx, fiatValue: undefined };
    const inventory: InventoryDisposal = {
      asset: 'BTC', disposedAt: unpriced.timestamp, amount: 1, costBasis: 60,
      holdingPeriodDays: 367, lotConsumption: [{ lotId: lot.id, amount: 1, costBasis: 60 }],
      sourceTxId: unpriced.id, method: 'FIFO', finalized: false
    };
    const model = buildTransactionCostAnalysisModel({
      transaction: unpriced,
      settings: settings('US'),
      indexes: indexes([buy, unpriced], [], [lot], [inventory])
    });
    expect(model).toMatchObject({
      pricingStatus: 'unpriced', disposedQuantity: 1, costBasis: 60,
      proceeds: undefined, gain: undefined
    });
    expect(model.matchedRows).toMatchObject([{
      sellAmount: 1, costBasis: 60, unitCost: 60, sourceLabel: 'coinbase'
    }]);
  });
  it('adds an explicit missing-basis remainder for a partially matched unpriced disposal', () => {
    const unpriced = { ...tx, fiatValue: undefined };
    const inventory: InventoryDisposal = {
      asset: 'BTC', disposedAt: unpriced.timestamp, amount: 1, costBasis: 30,
      holdingPeriodDays: 367, lotConsumption: [{ lotId: lot.id, amount: 0.5, costBasis: 30 }],
      sourceTxId: unpriced.id, method: 'FIFO', finalized: false
    };
    const model = buildTransactionCostAnalysisModel({
      transaction: unpriced,
      settings: settings('US'),
      indexes: indexes([buy, unpriced], [], [lot], [inventory])
    });
    expect(model).toMatchObject({
      disposedQuantity: 1,
      costBasis: 30,
      costBasisCompleteness: 'partial'
    });
    expect(model.matchedRows).toMatchObject([
      { sellAmount: 0.5, costBasis: 30, status: 'matched' },
      { sellAmount: 0.5, status: 'missing_cost_basis', sourceLabel: 'Missing acquisition' }
    ]);
    expect(model.matchedRows[1].costBasis).toBeUndefined();
    expect(model.matchedRows.reduce((sum, row) => sum + row.sellAmount, 0)).toBe(model.disposedQuantity);
    expect(model.warnings.join(' ')).toContain('Acquisition basis is missing or incomplete');
  });
  it('shows confirmed zero basis without warning and warns for unmatched shortfall', () => {
    const zeroLot = { ...lot, costBasisPerUnit: 0, costBasisTotal: 0 };
    const zeroDisposal = { ...disposal, costBasis: 0, gain: 100, lotConsumption: [{ lotId: lot.id, amount: 1, costBasis: 0 }] };
    const confirmed = buildTransactionCostAnalysisModel({ transaction: tx, settings: settings('US'), disposal: zeroDisposal, indexes: indexes([buy, tx], [zeroDisposal], [zeroLot]) });
    expect(confirmed.costBasis).toBe(0); expect(confirmed.warnings).toEqual([]);
    const missing = { ...zeroDisposal, lotConsumption: [] };
    expect(buildTransactionCostAnalysisModel({ transaction: tx, settings: settings('US'), disposal: missing, indexes: indexes([tx], [missing], []) }).warnings.join(' ')).toContain('missing');
  });
  it.each(['IN', 'US', 'CA', 'AE'] as const)('populates report-equivalent derivative amounts for %s', (jurisdiction) => {
    const derivative: Transaction = { ...tx, id: `perp-${jurisdiction}`, type: 'income', instrumentClass: 'derivative', category: 'perp_profit', fiatValue: 25, raw: { ntl: '100', closedPnl: '25', coin: 'BTC', sz: '1' } };
    const all = indexes([derivative], [], []); const model = buildTransactionCostAnalysisModel({ transaction: derivative, settings: settings(jurisdiction), indexes: all });
    const expected = defaultDerivativesTreatment(jurisdiction) === 'business_income' ? 'Business income' : 'Capital gains'; expect(model.derivativeTreatment).toBe(expected);
    if (expected === 'Business income') expect(model.businessIncome).toBe(25); else expect(model).toMatchObject({ proceeds: 100, costBasis: 75, gain: 25 });
    const override = expected === 'Business income' ? 'capital_gains' : 'business_income'; expect(buildTransactionCostAnalysisModel({ transaction: derivative, settings: settings(jurisdiction, override), indexes: all }).derivativeTreatment).not.toBe(expected);
  });
  it('uses exact fiat fees and keeps authority differences warning-only', () => {
    const feeTx = { ...tx, feeAsset: 'USD', feeAmount: 3 }; const all = indexes([buy, feeTx]);
    const baseline = buildTransactionCostAnalysisModel({ transaction: feeTx, settings: settings('US'), disposal, indexes: all });
    const warned = buildTransactionCostAnalysisModel({ transaction: feeTx, settings: settings('US'), disposal, indexes: all, unexplainedAuthorityQuantity: 9 });
    expect(baseline.valuations).toMatchObject([{ amount: 100, completeness: 'priced' }, { amount: 3, completeness: 'priced' }]);
    expect(warned).toMatchObject({ proceeds: baseline.proceeds, costBasis: baseline.costBasis, gain: baseline.gain }); expect(warned.warnings.join(' ')).toContain('does not change tax values');
  });
  it('keeps 30k expanded cost-model lookups below 100 ms p95 after one snapshot index build', () => {
    const transactions = Array.from({ length: 30_000 }, (_, index): Transaction => ({ ...tx, id: `tx-${index}`, type: 'transfer_in', fiatValue: index }));
    const all = indexes(transactions, [], []); const run = () => { const start = performance.now(); for (let index = 0; index < 30_000; index++) all.transactionById.get(`tx-${index}`); return performance.now() - start; };
    run(); const measures = Array.from({ length: 5 }, run).sort((a, b) => a - b); expect(measures[4]).toBeLessThan(100);
  });
});
