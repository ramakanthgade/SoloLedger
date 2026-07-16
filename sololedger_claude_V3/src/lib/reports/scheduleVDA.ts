/**
 * India Schedule VDA export (Task B4).
 *
 * Builds the row model behind the ITR "Schedule VDA" (Virtual Digital Assets)
 * disclosure from the cost-basis engine's matched lots, plus a clearly-labelled,
 * non-advice estimated-liability statement.
 *
 * Legal frame (encoded, not advice):
 *  - Section 115BBH: gains on a VDA transfer are taxed at a FLAT 30% (+ 4% health
 *    & education cess). The ONLY deduction allowed is the cost of acquisition —
 *    NO fees, no other expenditure — and losses cannot be set off against other
 *    gains or carried forward. Schedule VDA is therefore reported per transfer,
 *    with acquisition/transfer dates, cost of acquisition and consideration.
 *  - Section 56(2)(x) → 115BBH: income / gift / airdrop / staking VDA receipts
 *    are taxed at FMV-at-receipt as income from other sources (slab rate), and
 *    that same FMV-at-receipt becomes the cost of acquisition for the later
 *    115BBH transfer. So income/gift/airdrop lots already open at the correct
 *    cost — this module needs no "limited handling" caveat (resolved in B9a).
 *
 * This layer is pure: it takes the FY-scoped MatchedGainRow[] and TDS total and
 * produces rows + a raw-decimal CSV + an estimate object. It never computes the
 * slab-rate tax on receipts (that depends on total income) and it labels every
 * figure as a non-advice estimate.
 */
import type { Jurisdiction } from '@/types/transaction';
import type { MatchedGainRow, MatchedGainStatus } from '@/lib/costBasis/matchedGains';
import { add, toNumber } from '@/lib/costBasis/decimal';
import { estimateIndiaVDA } from '@/lib/tax/estimate';
import { isInFy } from '@/lib/utils';

/** One Schedule VDA line — a single matched transfer (per-lot). */
export interface ScheduleVdaRow {
  /** Stable id from the matched-lot row (`${disposalId}:${lotId}`). */
  id: string;
  /** VDA transferred. */
  asset: string;
  /** Date of acquisition (epoch ms) — from the matched buy lot. */
  acquisitionDate: number;
  /** Date of transfer (epoch ms) — the disposal (sell) leg. */
  transferDate: number;
  /** Cost of acquisition in reporting fiat (the ONLY deductible under 115BBH). */
  costOfAcquisition: number;
  /** Consideration received in reporting fiat (proceeds share for this lot). */
  considerationReceived: number;
  /** Income / gain on the transfer (consideration − cost of acquisition). */
  incomeGain: number;
  /**
   * Row provenance. `missing_cost_basis` means the transfer had no matched
   * acquisition — cost of acquisition is 0 (full consideration taxed) and the
   * filer must reconcile. Defaults to `matched`.
   */
  status: MatchedGainStatus;
}

/** Non-advice estimated-liability statement for the FY. */
export interface ScheduleVdaEstimate {
  /**
   * Taxable base: sum of POSITIVE per-transfer gains only. Under 115BBH losses
   * are disallowed, so negative-gain transfers never reduce the base.
   */
  taxableGains: number;
  /** Magnitude of disallowed losses (negative-gain transfers), for disclosure. */
  disallowedLosses: number;
  /**
   * Number of transfers included at ZERO cost of acquisition because no
   * acquisition was matched (`status === 'missing_cost_basis'`). These are in
   * the taxable base above but must be reconciled by the filer.
   */
  reviewRequiredCount: number;
  /** Flat 30% tax on the taxable base. */
  tax: number;
  /** 4% health & education cess on the tax. */
  cess: number;
  /** Estimated liability = tax + cess (== taxable × 0.312). */
  estimatedLiability: number;
  /** TDS already withheld (Section 194S), shown as an OFFSET against the above. */
  tdsOffset: number;
  /**
   * Estimated net after the TDS offset (estimatedLiability − tdsOffset). May be
   * negative, which indicates a TDS credit / potential refund to reconcile — it
   * is NOT netted to zero here.
   */
  netAfterTdsOffset: number;
}

/** Full Schedule VDA report: rows + estimate + factual notes. */
export interface ScheduleVdaReport {
  fy: number;
  jurisdiction: Jurisdiction;
  rows: ScheduleVdaRow[];
  estimate: ScheduleVdaEstimate;
  /**
   * Section 56(2)(x) receipt-side income (FMV-at-receipt of income/gift/airdrop
   * VDA events), taxed separately at slab rate. Surfaced when known.
   */
  vdaReceiptIncome?: number;
  /** Factual, non-advice notes to render/serialize alongside the table. */
  notes: string[];
}

/**
 * Factual notes (NOT advice, NOT a "limited handling" banner). These state the
 * statutory basis so a filer / CA can sanity-check the figures.
 */
export const SCHEDULE_VDA_COST_ONLY_NOTE =
  'Only the cost of acquisition is deducted from the consideration — no fees, ' +
  'brokerage or other expenditure — as required by Section 115BBH(2)(a).';

export const SCHEDULE_VDA_NO_OFFSET_NOTE =
  'Under Section 115BBH losses on VDA transfers cannot be set off against any ' +
  'gains or carried forward; loss-making transfers are excluded from the ' +
  'taxable base shown below.';

export const SCHEDULE_VDA_RECEIPT_NOTE =
  'Income / gift / airdrop / staking VDA lots use their fair-market value at ' +
  'receipt as the cost of acquisition (Section 56(2)(x) → 115BBH). That receipt ' +
  'is itself separately taxable as income from other sources at your slab rate.';

export const SCHEDULE_VDA_NOT_ADVICE_NOTE =
  'This is an automated, non-advice estimate: a flat 30% under Section 115BBH ' +
  'plus 4% health & education cess on the taxable base, with TDS (Section 194S) ' +
  'shown as an offset. Surcharge and slab-rate effects are out of scope — ' +
  'confirm final figures with your tax professional.';

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/** IST-local `YYYY-MM-DD` for an epoch (India runs at a fixed +05:30, no DST). */
export function istDateKey(timestampMs: number): string {
  return new Date(timestampMs + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Build the Schedule VDA rows for a financial year: one row per matched lot,
 * mapping 1:1 to the MatchedGainRow[] whose transfer (sell) date falls in the FY.
 * Rows preserve the input ordering (newest transfer first).
 */
export function buildScheduleVdaRows(
  matchedRows: MatchedGainRow[],
  fy: number,
  jurisdiction: Jurisdiction
): ScheduleVdaRow[] {
  return matchedRows
    .filter((r) => isInFy(r.sellDate, fy, jurisdiction))
    .map((r) => ({
      id: r.id,
      asset: r.asset,
      acquisitionDate: r.buyDate,
      transferDate: r.sellDate,
      costOfAcquisition: r.costBasis,
      considerationReceived: r.proceeds,
      incomeGain: r.gain,
      status: r.status ?? 'matched'
    }));
}

/**
 * Build the non-advice estimate: 30% + 4% cess on the sum of POSITIVE gains
 * (disallowed losses excluded), with `tdsTotal` (from `aggregateTds`) as an
 * offset line.
 */
export function buildScheduleVdaEstimate(
  rows: ScheduleVdaRow[],
  tdsTotal: number
): ScheduleVdaEstimate {
  let taxableGains = 0;
  let disallowedLosses = 0;
  let reviewRequiredCount = 0;
  for (const r of rows) {
    if (r.status === 'missing_cost_basis') reviewRequiredCount += 1;
    if (r.incomeGain > 0) taxableGains = toNumber(add(taxableGains, r.incomeGain));
    else if (r.incomeGain < 0) disallowedLosses = toNumber(add(disallowedLosses, -r.incomeGain));
  }

  const { tax, cess, total } = estimateIndiaVDA(taxableGains);
  const tdsOffset = Number.isFinite(tdsTotal) && tdsTotal > 0 ? tdsTotal : 0;

  return {
    taxableGains,
    disallowedLosses,
    reviewRequiredCount,
    tax,
    cess,
    estimatedLiability: total,
    tdsOffset,
    netAfterTdsOffset: toNumber(add(total, -tdsOffset))
  };
}

/**
 * Assemble a full Schedule VDA report (rows + estimate + factual notes) for the
 * FY. `vdaReceiptIncome` is the Section 56(2)(x) receipt-side income total, when
 * known (surfaced from `TaxYearSummary.vdaReceiptIncome`).
 */
export function buildScheduleVdaReport(
  matchedRows: MatchedGainRow[],
  tdsTotal: number,
  fy: number,
  jurisdiction: Jurisdiction,
  vdaReceiptIncome?: number
): ScheduleVdaReport {
  const rows = buildScheduleVdaRows(matchedRows, fy, jurisdiction);
  const estimate = buildScheduleVdaEstimate(rows, tdsTotal);

  const notes = [
    SCHEDULE_VDA_COST_ONLY_NOTE,
    SCHEDULE_VDA_NO_OFFSET_NOTE,
    SCHEDULE_VDA_RECEIPT_NOTE,
    SCHEDULE_VDA_NOT_ADVICE_NOTE
  ];

  return { fy, jurisdiction, rows, estimate, vdaReceiptIncome, notes };
}

const CSV_HEADER = [
  'date_of_acquisition',
  'date_of_transfer',
  'asset',
  'cost_of_acquisition_inr',
  'consideration_received_inr',
  'income_gain_inr'
];

/** Quote a CSV field only when it contains a comma, quote or newline. */
function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Serialize a Schedule VDA report to CSV.
 *
 * The transfer table uses RAW decimals (no rounding) for the monetary columns
 * so no precision is lost. The estimate statement and factual notes follow the
 * table as `#`-prefixed comment lines, keeping every figure clearly labelled as
 * a non-advice estimate.
 */
export function serializeScheduleVdaCsv(report: ScheduleVdaReport): string {
  const lines: string[] = [];
  lines.push(CSV_HEADER.join(','));

  for (const r of report.rows) {
    lines.push(
      [
        istDateKey(r.acquisitionDate),
        istDateKey(r.transferDate),
        csvField(r.asset),
        String(r.costOfAcquisition),
        String(r.considerationReceived),
        String(r.incomeGain)
      ].join(',')
    );
  }

  const e = report.estimate;
  lines.push('');
  lines.push('# Estimated liability (non-advice)');
  lines.push(`# Taxable gains (positive transfers only): ${e.taxableGains}`);
  lines.push(`# Disallowed losses (excluded, Section 115BBH): ${e.disallowedLosses}`);
  if (e.reviewRequiredCount > 0) {
    lines.push(
      `# REVIEW REQUIRED — transfers with no matched acquisition (taxed at zero cost of acquisition): ${e.reviewRequiredCount}`
    );
  }
  lines.push(`# Tax @ 30% (Section 115BBH): ${e.tax}`);
  lines.push(`# Health & education cess @ 4%: ${e.cess}`);
  lines.push(`# Estimated liability (30% + cess): ${e.estimatedLiability}`);
  lines.push(`# Less: TDS withheld (Section 194S) — offset: ${e.tdsOffset}`);
  lines.push(`# Estimated net after TDS offset: ${e.netAfterTdsOffset}`);
  if (report.vdaReceiptIncome != null && report.vdaReceiptIncome > 0) {
    lines.push(
      `# VDA receipt income (Section 56(2)(x), taxed at slab rate — separate): ${report.vdaReceiptIncome}`
    );
  }

  lines.push('');
  for (const note of report.notes) {
    lines.push(`# ${note}`);
  }

  return lines.join('\n');
}
