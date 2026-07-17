import { addYears } from 'date-fns';
import type { Disposal, Jurisdiction, TaxYearSummary } from '@/types/transaction';
import type { MatchedGainRow } from '@/lib/costBasis/matchedGains';
import { add, sub, toNumber } from '@/lib/costBasis/decimal';
import { applyInclusion, estimateIndiaVDA, sumReceiptIncome } from '@/lib/tax/estimate';
import { isInFy } from '@/lib/utils';

/**
 * Jurisdiction modules take the same Disposal[]/income figures produced by
 * the cost-basis engine and apply local rules. The engine itself never
 * changes per country — only this layer does. Adding a new country is
 * adding a new entry here.
 */
export interface JurisdictionRules {
  code: Jurisdiction;
  label: string;
  currency: string;
  /** Whether short vs long-term holding period changes tax treatment. */
  hasHoldingPeriodDistinction: boolean;
  longTermThresholdDays: number | null;
  /** Whether capital losses may offset capital gains at all. */
  lossesOffsetGains: boolean;
  notes: string;
}

export const JURISDICTIONS: Record<Jurisdiction, JurisdictionRules> = {
  IN: {
    code: 'IN',
    label: 'India',
    currency: 'INR',
    hasHoldingPeriodDistinction: false,
    longTermThresholdDays: null,
    lossesOffsetGains: false,
    notes:
      'Under Indian rules (Section 115BBH), gains on Virtual Digital Assets are taxed at a flat 30%, ' +
      'with no deduction for losses against other gains and no distinction between short- and long-term ' +
      'holding. This report presents figures for your CA to apply current-year rates — it is not tax advice.'
  },
  US: {
    code: 'US',
    label: 'United States',
    currency: 'USD',
    hasHoldingPeriodDistinction: true,
    longTermThresholdDays: 365,
    lossesOffsetGains: true,
    notes:
      'US filers typically report crypto disposals on Form 8949 / Schedule D, split between short-term ' +
      '(held \u2264 1 year) and long-term. This report groups disposals accordingly — confirm current-year ' +
      'rates and limits with your tax professional.'
  },
  CA: {
    code: 'CA',
    label: 'Canada',
    currency: 'CAD',
    hasHoldingPeriodDistinction: false,
    longTermThresholdDays: null,
    lossesOffsetGains: true,
    notes:
      'CRA generally taxes 50% of capital gains on crypto dispositions (business-income treatment may ' +
      'apply for frequent trading). This report shows full gains/losses; apply the appropriate inclusion ' +
      'rate with your accountant.'
  },
  AE: {
    code: 'AE',
    label: 'United Arab Emirates',
    currency: 'AED',
    hasHoldingPeriodDistinction: false,
    longTermThresholdDays: null,
    lossesOffsetGains: true,
    notes:
      'The UAE currently has no personal capital gains tax for individuals. This report is provided for ' +
      'record-keeping, corporate tax assessment (if applicable), or cross-border filing needs.'
  }
};

/** Canada capital-gains inclusion rate (50%). */
const CA_INCLUSION_RATE = 0.5;

/**
 * Exact calendar long-term test. A holding is long-term when a full year has
 * elapsed between acquisition and disposal, computed with `date-fns` `addYears`
 * so leap years (e.g. a Feb-29 acquisition) are handled correctly — never a
 * `round(days) >= 365` approximation.
 *
 * The US bright line is "held more than one year", so the anniversary itself
 * is still short-term (strictly-greater). Other jurisdictions treat the
 * one-year mark as long-term (>=).
 */
function isLongTerm(acquiredAt: number, disposedAt: number, jurisdiction: Jurisdiction): boolean {
  const boundary = addYears(new Date(acquiredAt), 1).getTime();
  return jurisdiction === 'US' ? disposedAt > boundary : disposedAt >= boundary;
}

export function summarizeYear(
  disposals: Disposal[],
  matchedRows: MatchedGainRow[],
  incomeEvents: { fiatValue: number; timestamp?: number }[],
  year: number,
  jurisdiction: Jurisdiction,
  extras?: {
    derivativesIncome?: number;
    derivativesExpenses?: number;
    /**
     * India Section 56(2)(x) receipt-side income events (FMV-at-receipt of
     * income/gift/airdrop/staking VDA lots, MINING EXCLUDED). Build with
     * `buildReceiptIncomeRows`. When supplied, `vdaReceiptIncome` derives from
     * these typed rows; when omitted it falls back to `incomeEvents`.
     */
    receiptIncomeEvents?: { fiatValue: number; timestamp?: number }[];
  }
): TaxYearSummary {
  const rules = JURISDICTIONS[jurisdiction];
  const yearDisposals = disposals.filter((d) => isInFy(d.disposedAt, year, jurisdiction));
  const yearRows = matchedRows.filter((r) => isInFy(r.sellDate, year, jurisdiction));

  const byAsset: TaxYearSummary['byAsset'] = {};
  let totalProceeds = 0;
  let totalCostBasis = 0;
  let totalGains = 0;   // positive-gain lots only
  let totalLosses = 0;  // magnitude of negative-gain lots
  let shortTermGain = 0;
  let longTermGain = 0;

  for (const r of yearRows) {
    totalProceeds += r.proceeds;
    totalCostBasis += r.costBasis;

    if (r.gain >= 0) totalGains = toNumber(add(totalGains, r.gain));
    else totalLosses = toNumber(sub(totalLosses, r.gain)); // -gain = +magnitude

    if (!byAsset[r.asset]) byAsset[r.asset] = { proceeds: 0, costBasis: 0, gain: 0 };
    byAsset[r.asset].proceeds += r.proceeds;
    byAsset[r.asset].costBasis += r.costBasis;
    byAsset[r.asset].gain += r.gain;

    if (rules.hasHoldingPeriodDistinction) {
      if (isLongTerm(r.buyDate, r.sellDate, jurisdiction)) longTermGain += r.gain;
      else shortTermGain += r.gain;
    }
  }

  // No-offset jurisdictions (India, Section 115BBH): taxable = positive gains
  // only; negative-gain lots are disallowed losses and are NEVER netted.
  // Offset-allowed jurisdictions keep the net gain/loss behaviour.
  const totalGain = rules.lossesOffsetGains
    ? toNumber(sub(totalGains, totalLosses))
    : totalGains;
  const disallowedLosses = rules.lossesOffsetGains ? undefined : totalLosses;

  const yearIncomeEvents = incomeEvents.filter(
    (e) => e.timestamp != null && isInFy(e.timestamp, year, jurisdiction)
  );
  const totalIncome = yearIncomeEvents.reduce((s, e) => s + (e.fiatValue || 0), 0);

  // India Section 56(2)(x): the FMV-at-receipt of income/gift/airdrop/staking
  // VDA events is income from other sources taxed at the recipient's SLAB rate
  // — a receipt-side charge separate from the 30% + 4% cess on the later VDA
  // transfer under Section 115BBH. Surfaced so reports can show it as its own
  // line. Slab-rate tax is out of scope (depends on total income).
  //
  // Prefer the typed receipt-income events (mining excluded, gifts/airdrops
  // included via `buildReceiptIncomeRows`); fall back to `incomeEvents` for
  // callers that have not been migrated yet.
  const receiptEventsForYear = (extras?.receiptIncomeEvents ?? incomeEvents).filter(
    (e) => e.timestamp != null && isInFy(e.timestamp, year, jurisdiction)
  );
  const vdaReceiptIncome =
    jurisdiction === 'IN' ? sumReceiptIncome(receiptEventsForYear) : undefined;

  // Legal basis, VALIDATED FROM PRIMARY SOURCES (was a CA-validation gate):
  //  - Section 115BBH(2)(a): the ONLY deduction on a VDA transfer is the cost
  //    of acquisition (no other expenditure; losses cannot be set off/carried).
  //  - Section 56(2)(x): airdrops/staking/gifts are taxed at receipt at FMV
  //    (slab rate), and that FMV-at-receipt BECOMES the cost of acquisition for
  //    the later 115BBH sale.
  // Opening income/gift/airdrop lots at FULL FMV-at-receipt (the engine's
  // existing behaviour) is therefore CORRECT, so the earlier
  // `incomeGiftTreatmentLimited` doubt is resolved in its favour: the flag is
  // no longer raised. The field is kept on the type (additive) but stays false.
  const incomeGiftTreatmentLimited = false;

  const inclusionRate = jurisdiction === 'CA' ? CA_INCLUSION_RATE : undefined;

  // Taxable base actually used for tax, per jurisdiction:
  //  - CA: the inclusion-adjusted amount (50% of the net gain) is applied here,
  //    not left as mere metadata. Losses reduce the net first (offset allowed),
  //    then the inclusion rate scales the positive remainder; a net loss yields
  //    a zero taxable base (no negative inclusion).
  //  - IN: `totalGain` is already the 115BBH positive-gains-only base.
  //  - US/AE: `totalGain` is the net gain/loss.
  const taxableGain =
    inclusionRate != null ? applyInclusion(Math.max(0, totalGain), inclusionRate) : totalGain;

  const estimatedTax =
    jurisdiction === 'IN' ? estimateIndiaVDA(totalGain).total : undefined;

  // Rows whose proceeds have no proven acquisition cost (included at zero cost
  // basis, flagged for the filer to reconcile).
  const reviewRequiredCount = yearRows.filter((r) => r.status === 'missing_cost_basis').length;

  return {
    year,
    jurisdiction,
    totalProceeds,
    totalCostBasis,
    totalGain,
    taxableGain,
    shortTermGain: rules.hasHoldingPeriodDistinction ? shortTermGain : undefined,
    longTermGain: rules.hasHoldingPeriodDistinction ? longTermGain : undefined,
    totalGains,
    totalLosses,
    disallowedLosses,
    inclusionRate,
    estimatedTax,
    reviewRequiredCount,
    incomeGiftTreatmentLimited,
    vdaReceiptIncome,
    totalIncome,
    derivativesIncome: extras?.derivativesIncome,
    derivativesExpenses: extras?.derivativesExpenses,
    disposalsCount: yearDisposals.length,
    byAsset
  };
}
