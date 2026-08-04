import type { Disposal, Lot, TaxSettings, Transaction } from '@/types/transaction';
import type { InventoryDisposal } from '@/lib/costBasis/engine';
import { buildDerivativeBusinessExpenseRows, buildDerivativeBusinessIncomeRows, buildDerivativeCapitalGainRows, buildMatchedGainRows, type MatchedGainRow } from '@/lib/costBasis/matchedGains';
import { JURISDICTIONS, summarizeGainTreatment, type GainTreatmentSummary } from '@/lib/tax/jurisdictions';
import { isDerivativeTransaction, resolveDerivativesTreatment } from '@/lib/tax/derivatives';
import { buildTransactionValuationRow, type TransactionValuationRow } from './transactionValuationModel';

export interface TransactionCostLotRow extends Omit<MatchedGainRow, 'proceeds' | 'costBasis' | 'gain'> { sourceLabel: string; acquisitionType: string; proceeds?: number; costBasis?: number; gain?: number; unitCost?: number }
export interface TransactionCostAnalysisIndexes {
  readonly matchedBySellTxId: ReadonlyMap<string, readonly MatchedGainRow[]>;
  readonly inventoryBySellTxId: ReadonlyMap<string, InventoryDisposal>;
  readonly derivativeCapitalByTxId: ReadonlyMap<string, MatchedGainRow>;
  readonly derivativeIncomeByTxId: ReadonlyMap<string, number>;
  readonly derivativeExpenseByTxId: ReadonlyMap<string, number>;
  readonly transactionById: ReadonlyMap<string, Transaction>;
  readonly lotById: ReadonlyMap<string, Lot>;
}

export function buildTransactionCostAnalysisIndexes(input: { disposals: readonly Disposal[]; inventoryDisposals?: readonly InventoryDisposal[]; lots: readonly Lot[]; transactions: readonly Transaction[] }): TransactionCostAnalysisIndexes {
  const transactions = [...input.transactions]; const lots = [...input.lots];
  const matchedBySellTxId = new Map<string, MatchedGainRow[]>();
  for (const row of buildMatchedGainRows([...input.disposals], lots, transactions)) { const rows = matchedBySellTxId.get(row.sellTxId); if (rows) rows.push(row); else matchedBySellTxId.set(row.sellTxId, [row]); }
  return {
    matchedBySellTxId,
    inventoryBySellTxId: new Map((input.inventoryDisposals ?? []).map((row) => [row.sourceTxId, row])),
    derivativeCapitalByTxId: new Map(buildDerivativeCapitalGainRows(transactions).map((row) => [row.sellTxId, row])),
    derivativeIncomeByTxId: new Map(buildDerivativeBusinessIncomeRows(transactions).map((row) => [row.txId, row.fiatValue])),
    derivativeExpenseByTxId: new Map(buildDerivativeBusinessExpenseRows(transactions).map((row) => [row.txId, row.fiatValue])),
    transactionById: new Map(transactions.map((row) => [row.id, row])), lotById: new Map(lots.map((row) => [row.id, row]))
  };
}

export interface TransactionCostAnalysisModel {
  jurisdictionLabel: string; currency: string; yearConvention: 'financial year' | 'calendar year'; method: TaxSettings['defaultCostBasisMethod'];
  derivativeTreatment?: 'Business income' | 'Capital gains'; classification: string; pricingStatus: 'priced' | 'unpriced';
  disposedQuantity?: number; disposedAsset?: string; proceeds?: number; costBasis?: number; costBasisCompleteness?: 'complete' | 'partial'; gain?: number; businessIncome?: number; businessExpense?: number;
  eventTreatment?: GainTreatmentSummary;
  matchedRows: TransactionCostLotRow[]; valuations: TransactionValuationRow[]; warnings: string[];
}

/** Read-only projection of the same engine/report rows used elsewhere. */
export function buildTransactionCostAnalysisModel(input: { transaction: Transaction; settings: TaxSettings; disposal?: Disposal; indexes: TransactionCostAnalysisIndexes; unexplainedAuthorityQuantity?: number }): TransactionCostAnalysisModel {
  const { transaction, settings, disposal, indexes } = input;
  const derivative = isDerivativeTransaction(transaction); const treatment = resolveDerivativesTreatment(settings); const priced = transaction.fiatValue != null;
  const derivativeCapital = derivative && treatment === 'capital_gains' ? indexes.derivativeCapitalByTxId.get(transaction.id) : undefined;
  const inventoryDisposal = indexes.inventoryBySellTxId.get(transaction.id);
  const sourceRows = derivativeCapital ? [derivativeCapital] : [...(indexes.matchedBySellTxId.get(transaction.id) ?? [])];
  const finalizedRows = sourceRows.map((row) => { const acquisition = indexes.transactionById.get(row.buyTxId); const { proceeds: rowProceeds, costBasis: rowCostBasis, gain: rowGain, ...facts } = row; return { ...facts, proceeds: priced ? rowProceeds : undefined, costBasis: rowCostBasis, gain: priced ? rowGain : undefined, sourceLabel: acquisition?.source ?? (row.buyTxId ? 'Imported transaction' : 'Missing acquisition'), acquisitionType: acquisition?.type.replace(/_/g, ' ') ?? 'basis unavailable', unitCost: row.status !== 'missing_cost_basis' && row.buyAmount > 0 ? rowCostBasis / row.buyAmount : undefined }; });
  const inventoryMatchedRows: TransactionCostLotRow[] = !priced && inventoryDisposal
    ? inventoryDisposal.lotConsumption.flatMap((consumption) => {
        const lot = indexes.lotById.get(consumption.lotId);
        if (!lot) return [];
        const acquisition = indexes.transactionById.get(lot.sourceTxId);
        return [{
          id: `inventory:${inventoryDisposal.sourceTxId}:${lot.id}`,
          asset: inventoryDisposal.asset,
          sellDate: inventoryDisposal.disposedAt,
          sellAmount: consumption.amount,
          sellTxId: inventoryDisposal.sourceTxId,
          buyDate: lot.acquiredAt,
          buyAmount: consumption.amount,
          costBasis: consumption.costBasis,
          buyTxId: lot.sourceTxId,
          holdingDays: Math.max(0, Math.round((inventoryDisposal.disposedAt - lot.acquiredAt) / 86_400_000)),
          method: inventoryDisposal.method,
          status: 'matched' as const,
          sourceLabel: acquisition?.source ?? 'Imported transaction',
          acquisitionType: acquisition?.type.replace(/_/g, ' ') ?? lot.acquisitionType.replace(/_/g, ' '),
          unitCost: consumption.amount > 0 ? consumption.costBasis / consumption.amount : undefined
        }];
      })
    : [];
  const inventoryMatchedAmount = inventoryMatchedRows.reduce((sum, row) => sum + row.sellAmount, 0);
  const inventoryUnmatchedAmount = inventoryDisposal
    ? Math.max(0, inventoryDisposal.amount - inventoryMatchedAmount)
    : 0;
  const inventoryRows: TransactionCostLotRow[] = inventoryDisposal && inventoryUnmatchedAmount > 1e-10
    ? [...inventoryMatchedRows, {
        id: `inventory:${inventoryDisposal.sourceTxId}:unmatched`,
        asset: inventoryDisposal.asset,
        sellDate: inventoryDisposal.disposedAt,
        sellAmount: inventoryUnmatchedAmount,
        sellTxId: inventoryDisposal.sourceTxId,
        buyDate: inventoryDisposal.disposedAt,
        buyAmount: 0,
        buyTxId: '',
        holdingDays: 0,
        method: inventoryDisposal.method,
        status: 'missing_cost_basis',
        sourceLabel: 'Missing acquisition',
        acquisitionType: 'basis unavailable'
      }]
    : inventoryMatchedRows;
  const matchedRows = finalizedRows.length > 0 ? finalizedRows : inventoryRows;
  const eventTreatment = priced && sourceRows.length > 0 ? summarizeGainTreatment(sourceRows, settings.jurisdiction) : undefined;
  const warnings: string[] = [];
  if (matchedRows.some((row) => row.status === 'missing_cost_basis')) warnings.push('Acquisition basis is missing or incomplete. Review source history; no replacement basis was inferred.');
  if (!priced) warnings.push('Market value is unavailable. Proceeds and gain are not finalized. Acquisition cost basis is a separate lot-history question and is never inferred from this value.');
  if (input.unexplainedAuthorityQuantity != null && Math.abs(input.unexplainedAuthorityQuantity) > 1e-10) warnings.push(`Authority evidence differs from posting history by ${input.unexplainedAuthorityQuantity} ${transaction.asset}. This custody warning does not change tax values.`);
  const valuations = [buildTransactionValuationRow({ kind: 'fiat_valuation', transactionId: transaction.id, currency: transaction.fiatCurrency, amount: transaction.fiatValue })];
  if (transaction.feeAmount != null) { const fiatFee = transaction.feeAsset?.toUpperCase() === transaction.fiatCurrency.toUpperCase() ? transaction.feeAmount : undefined; valuations.push(buildTransactionValuationRow({ kind: 'fee_expense', transactionId: transaction.id, currency: transaction.fiatCurrency, amount: fiatFee, completeness: fiatFee == null ? 'partial' : 'priced' })); }
  return {
    jurisdictionLabel: JURISDICTIONS[settings.jurisdiction].label, currency: settings.reportingCurrency, yearConvention: settings.jurisdiction === 'IN' ? 'financial year' : 'calendar year', method: disposal?.method ?? inventoryDisposal?.method ?? settings.defaultCostBasisMethod,
    derivativeTreatment: derivative ? (treatment === 'business_income' ? 'Business income' : 'Capital gains') : undefined,
    classification: derivative ? `Derivative · ${treatment === 'business_income' ? 'business income' : 'capital gains'}` : disposal || inventoryDisposal ? 'Asset disposal' : transaction.type.replace(/_/g, ' '), pricingStatus: priced ? 'priced' : 'unpriced',
    disposedQuantity: disposal?.amount ?? inventoryDisposal?.amount ?? derivativeCapital?.sellAmount, disposedAsset: disposal?.asset ?? inventoryDisposal?.asset ?? derivativeCapital?.asset,
    proceeds: priced ? (disposal?.proceeds ?? derivativeCapital?.proceeds) : undefined, costBasis: disposal?.costBasis ?? inventoryDisposal?.costBasis ?? derivativeCapital?.costBasis, costBasisCompleteness: disposal || inventoryDisposal ? (matchedRows.some((row) => row.status === 'missing_cost_basis') ? 'partial' : 'complete') : undefined, gain: priced ? (disposal?.gain ?? derivativeCapital?.gain) : undefined,
    businessIncome: derivative && treatment === 'business_income' ? indexes.derivativeIncomeByTxId.get(transaction.id) : undefined, businessExpense: derivative && treatment === 'business_income' ? indexes.derivativeExpenseByTxId.get(transaction.id) : undefined,
    eventTreatment, matchedRows, valuations, warnings
  };
}
