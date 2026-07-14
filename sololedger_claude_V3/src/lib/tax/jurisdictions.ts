import type { Disposal, Jurisdiction, TaxYearSummary } from '@/types/transaction';
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

export function summarizeYear(
  disposals: Disposal[],
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

  const byAsset: TaxYearSummary['byAsset'] = {};
  let totalProceeds = 0;
  let totalCostBasis = 0;
  let totalGain = 0;
  let shortTermGain = 0;
  let longTermGain = 0;

  for (const d of yearDisposals) {
    totalProceeds += d.proceeds;
    totalCostBasis += d.costBasis;
    totalGain += d.gain;

    if (!byAsset[d.asset]) byAsset[d.asset] = { proceeds: 0, costBasis: 0, gain: 0 };
    byAsset[d.asset].proceeds += d.proceeds;
    byAsset[d.asset].costBasis += d.costBasis;
    byAsset[d.asset].gain += d.gain;

    if (rules.hasHoldingPeriodDistinction && rules.longTermThresholdDays != null) {
      if (d.holdingPeriodDays >= rules.longTermThresholdDays) longTermGain += d.gain;
      else shortTermGain += d.gain;
    }
  }

  const totalIncome = incomeEvents
    .filter((e) => e.timestamp != null && isInFy(e.timestamp, year, jurisdiction))
    .reduce((s, e) => s + (e.fiatValue || 0), 0);

  return {
    year,
    jurisdiction,
    totalProceeds,
    totalCostBasis,
    totalGain,
    shortTermGain: rules.hasHoldingPeriodDistinction ? shortTermGain : undefined,
    longTermGain: rules.hasHoldingPeriodDistinction ? longTermGain : undefined,
    totalIncome,
    derivativesIncome: extras?.derivativesIncome,
    derivativesExpenses: extras?.derivativesExpenses,
    disposalsCount: yearDisposals.length,
    byAsset
  };
}
