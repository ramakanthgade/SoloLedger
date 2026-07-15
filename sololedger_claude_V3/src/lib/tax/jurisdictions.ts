import { addYears } from 'date-fns';
import type { Disposal, Jurisdiction, TaxYearSummary } from '@/types/transaction';
import type { MatchedGainRow } from '@/lib/costBasis/matchedGains';
import { add, sub, toNumber } from '@/lib/costBasis/decimal';
import { estimateIndiaVDA } from '@/lib/tax/estimate';
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

  const totalIncome = incomeEvents
    .filter((e) => e.timestamp != null && isInFy(e.timestamp, year, jurisdiction))
    .reduce((s, e) => s + (e.fiatValue || 0), 0);

  // India-only flag: income/gift/airdrop VDA lots carry receipt-side treatment
  // not yet modelled here (B9a clears this). Keyed off income presence so the
  // condition stays a single, cleanly separable expression.
  const incomeGiftTreatmentLimited =
    jurisdiction === 'IN' && totalIncome > 0 ? true : undefined;

  const inclusionRate = jurisdiction === 'CA' ? CA_INCLUSION_RATE : undefined;
  const estimatedTax =
    jurisdiction === 'IN' ? estimateIndiaVDA(totalGain).total : undefined;

  return {
    year,
    jurisdiction,
    totalProceeds,
    totalCostBasis,
    totalGain,
    shortTermGain: rules.hasHoldingPeriodDistinction ? shortTermGain : undefined,
    longTermGain: rules.hasHoldingPeriodDistinction ? longTermGain : undefined,
    totalGains,
    totalLosses,
    disallowedLosses,
    inclusionRate,
    estimatedTax,
    incomeGiftTreatmentLimited,
    totalIncome,
    derivativesIncome: extras?.derivativesIncome,
    derivativesExpenses: extras?.derivativesExpenses,
    disposalsCount: yearDisposals.length,
    byAsset
  };
}
