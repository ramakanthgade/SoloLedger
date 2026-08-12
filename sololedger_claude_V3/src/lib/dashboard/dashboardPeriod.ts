import type { Jurisdiction } from '@/types/transaction';
import {
  getFyBoundaries,
  getFyForTimestamp,
  getFyLabel,
  inclusiveCivilDateRange,
  IST_OFFSET_MS
} from '@/lib/utils';

export type DashboardPeriodId = 'this-tax-year' | 'last-tax-year' | 'prior-tax-year' | 'custom';

export interface DashboardPeriodSelection {
  id: DashboardPeriodId;
  nominalStart: number;
  nominalEnd: number;
  effectiveEnd: number;
  nominalLabel: string;
  effectiveLabel: string;
  taxLabel: string;
}

export interface DashboardPeriodControl {
  id: Exclude<DashboardPeriodId, 'custom'> | 'custom';
  label: string;
  financialYear?: number;
}

export type DashboardCustomPeriodResult =
  | { ok: true; selection: DashboardPeriodSelection }
  | { ok: false; reason: 'invalid-date' | 'future-start' | 'start-after-end' };

function civilDateKey(timestampMs: number, jurisdiction: Jurisdiction): string {
  if (jurisdiction === 'IN') return new Date(timestampMs + IST_OFFSET_MS).toISOString().slice(0, 10);
  const date = new Date(timestampMs);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function formatCivilDate(timestampMs: number, jurisdiction: Jurisdiction): string {
  const date = jurisdiction === 'IN' ? new Date(timestampMs + IST_OFFSET_MS) : new Date(timestampMs);
  const year = jurisdiction === 'IN' ? date.getUTCFullYear() : date.getFullYear();
  const month = jurisdiction === 'IN' ? date.getUTCMonth() : date.getMonth();
  const day = jurisdiction === 'IN' ? date.getUTCDate() : date.getDate();
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC'
  }).format(new Date(Date.UTC(year, month, day)));
}

function selection(
  id: DashboardPeriodId,
  nominalStart: number,
  nominalEnd: number,
  nowMs: number,
  jurisdiction: Jurisdiction,
  nominalLabel: string,
  taxLabel: string
): DashboardPeriodSelection {
  const effectiveEnd = Math.min(nominalEnd, nowMs);
  return {
    id,
    nominalStart,
    nominalEnd,
    effectiveEnd,
    nominalLabel,
    effectiveLabel: `Data through ${formatCivilDate(effectiveEnd, jurisdiction)}`,
    taxLabel
  };
}

/** Stable quick controls derived entirely from the injected clock. */
export function dashboardPeriodControls(
  jurisdiction: Jurisdiction,
  nowMs: number
): DashboardPeriodControl[] {
  const current = getFyForTimestamp(nowMs, jurisdiction);
  return [
    { id: 'this-tax-year', label: 'This tax year', financialYear: current },
    { id: 'last-tax-year', label: 'Last tax year', financialYear: current - 1 },
    { id: 'prior-tax-year', label: getFyLabel(current - 2, jurisdiction), financialYear: current - 2 },
    { id: 'custom', label: 'Custom range' }
  ];
}

export function selectDashboardTaxYearPeriod(
  id: Exclude<DashboardPeriodId, 'custom'>,
  jurisdiction: Jurisdiction,
  nowMs: number
): DashboardPeriodSelection {
  const current = getFyForTimestamp(nowMs, jurisdiction);
  const offset = id === 'this-tax-year' ? 0 : id === 'last-tax-year' ? 1 : 2;
  const fy = current - offset;
  const { start, end } = getFyBoundaries(fy, jurisdiction);
  const rangeLabel = `${formatCivilDate(start, jurisdiction)}–${formatCivilDate(end, jurisdiction)}`;
  const taxLabel = getFyLabel(fy, jurisdiction);
  return selection(id, start, end, nowMs, jurisdiction, `${taxLabel} · ${rangeLabel}`, taxLabel);
}

/**
 * Parse an inclusive custom civil range. A future nominal end is valid and is
 * clamped to the injected current instant; a future start is invalid.
 */
export function selectDashboardCustomPeriod(
  startDate: string,
  endDate: string,
  jurisdiction: Jurisdiction,
  nowMs: number
): DashboardCustomPeriodResult {
  const range = inclusiveCivilDateRange(startDate, endDate, jurisdiction);
  if (!range) {
    const individuallyValid = inclusiveCivilDateRange(startDate, startDate, jurisdiction) &&
      inclusiveCivilDateRange(endDate, endDate, jurisdiction);
    return { ok: false, reason: individuallyValid ? 'start-after-end' : 'invalid-date' };
  }
  if (startDate > civilDateKey(nowMs, jurisdiction)) return { ok: false, reason: 'future-start' };
  return {
    ok: true,
    selection: selection(
      'custom', range.start, range.end, nowMs, jurisdiction,
      `${formatCivilDate(range.start, jurisdiction)}–${formatCivilDate(range.end, jurisdiction)}`,
      'Custom range'
    )
  };
}

/** Re-evaluate a user's period intent against a new coherent clock/settings read. */
export function rederiveDashboardPeriod(
  current: DashboardPeriodSelection | undefined,
  previousJurisdiction: Jurisdiction | undefined,
  jurisdiction: Jurisdiction,
  nowMs: number
): DashboardPeriodSelection {
  if (!current) return selectDashboardTaxYearPeriod('this-tax-year', jurisdiction, nowMs);
  if (current.id !== 'custom') return selectDashboardTaxYearPeriod(current.id, jurisdiction, nowMs);
  const from = previousJurisdiction ?? jurisdiction;
  const start = civilDateKey(current.nominalStart, from);
  const end = civilDateKey(current.nominalEnd, from);
  const custom = selectDashboardCustomPeriod(start, end, jurisdiction, nowMs);
  return custom.ok ? custom.selection : selectDashboardTaxYearPeriod('this-tax-year', jurisdiction, nowMs);
}
