/**
 * India VDA tax-estimate card (Task T4).
 *
 * Renders the flat 30% (Section 115BBH) + 4% health & education cess (≈31.2%
 * effective) estimate on the FY's taxable VDA transfer gains, with the 1% TDS
 * (Section 194S) already withheld shown as a credit. Two render modes:
 *
 *  - `variant="kpi"`   → a compact stat-card used as a Portfolio KPI (it swaps
 *                        the T2 `data-t4-stub` est-tax card).
 *  - `variant="panel"` → the full breakdown card shown in Reports, matching
 *                        `aurora-tax-estimate-view.html`.
 *
 * Every figure is labelled a non-advice estimate with NO loss set-off applied
 * (Sec 115BBH). When `receiptIncome` is present it is shown as a SEPARATE line
 * taxed at slab rate under Sec 56(2)(x), clearly distinct from the 30% transfer
 * estimate. The math is delegated to `estimateIndiaVDA` (the same helper B2/B4
 * use) so the card can never drift from the report/CSV figures.
 */
import { estimateIndiaVDA } from '@/lib/tax/estimate';
import { formatCurrency, getFyLabel } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle, Badge } from '@/components/ui/card';

/** The "estimate, no set-off, not advice" line — asserted verbatim in tests. */
export const TAX_ESTIMATE_NO_OFFSET_NOTE =
  'Estimate only — no loss set-off applied (Section 115BBH). Not tax advice.';

export interface TaxEstimateCardProps {
  /** Taxable VDA transfer gains for the FY (positive gains only; B2/B4 base). */
  taxableGains: number;
  /** Section 194S TDS already withheld, shown as a credit. Defaults to 0. */
  tdsWithheld?: number;
  /** Section 56(2)(x) receipt income (slab-rate, separate). Optional. */
  receiptIncome?: number;
  /** Reporting currency (e.g. "INR"). */
  currency: string;
  /** FY number, used only for the label. */
  fy: number;
  /** 'kpi' (Portfolio stat-card) or 'panel' (full Reports breakdown). */
  variant?: 'kpi' | 'panel';
  className?: string;
}

export function TaxEstimateCard({
  taxableGains,
  tdsWithheld = 0,
  receiptIncome,
  currency,
  fy,
  variant = 'panel',
  className
}: TaxEstimateCardProps) {
  const { tax, cess, total } = estimateIndiaVDA(taxableGains);
  const credit = Number.isFinite(tdsWithheld) && tdsWithheld > 0 ? tdsWithheld : 0;
  const netPayable = total - credit;
  const hasReceipts = receiptIncome != null && receiptIncome > 0;

  if (variant === 'kpi') {
    return (
      <div className={'stat-card min-w-0 ' + (className ?? '')} data-testid="tax-estimate-kpi">
        <p className="text-[0.6875rem] font-semibold uppercase tracking-wider text-low">
          Est. tax — {getFyLabel(fy, 'IN')}
        </p>
        <p className="mt-2 font-mono text-lg font-semibold tabular-figures text-warn sm:text-xl">
          {formatCurrency(total, currency)}
        </p>
        <p className="mt-1 text-[0.6875rem] text-low">
          30% + 4% cess on {formatCurrency(taxableGains, currency)} gains
        </p>
        {credit > 0 && (
          <p className="mt-0.5 text-[0.6875rem] text-low">
            Net of TDS credit: {formatCurrency(netPayable, currency)}
          </p>
        )}
        <p className="mt-1 text-[0.625rem] text-faint" data-testid="tax-estimate-kpi-note">
          Estimate — not tax advice.
        </p>
      </div>
    );
  }

  return (
    <Card className={className} data-testid="tax-estimate-panel">
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>Tax estimate — {getFyLabel(fy, 'IN')}</CardTitle>
        <Badge tone="gold">≈31.2% effective</Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-white/10 bg-elev-1/60 p-4">
            <p className="text-[0.6875rem] font-semibold uppercase tracking-wider text-low">
              Capital gains taxed at 30%
            </p>
            <p className="mt-2 font-mono text-xl font-semibold tabular-figures text-gain">
              {formatCurrency(taxableGains, currency)}
            </p>
            <p className="mt-1 text-[0.6875rem] text-low">
              Winners only — losses aren&apos;t set off (Section 115BBH)
            </p>
          </div>
          <div className="rounded-xl border border-violet/40 bg-gradient-to-br from-elev-2 to-elev-3 p-4 shadow-glow">
            <p className="text-[0.6875rem] font-semibold uppercase tracking-wider text-mid">
              Estimated tax you still owe
            </p>
            <p className="mt-2 font-mono text-xl font-semibold tabular-figures text-hi">
              {formatCurrency(netPayable, currency)}
            </p>
            <dl className="mt-3 space-y-1 font-mono text-xs tabular-figures text-low">
              <div className="flex justify-between gap-4">
                <dt>30% on gains</dt>
                <dd className="text-mid">{formatCurrency(tax, currency)}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt>+ 4% health &amp; edu cess</dt>
                <dd className="text-mid">{formatCurrency(cess, currency)}</dd>
              </div>
              <div className="flex justify-between gap-4 border-t border-white/10 pt-1">
                <dt>= Total (30% + cess)</dt>
                <dd className="text-hi">{formatCurrency(total, currency)}</dd>
              </div>
              {credit > 0 && (
                <div className="flex justify-between gap-4 text-gain">
                  <dt>− 1% TDS credit (Section 194S)</dt>
                  <dd>−{formatCurrency(credit, currency)}</dd>
                </div>
              )}
            </dl>
          </div>
        </div>

        {hasReceipts && (
          <div className="rounded-xl border border-white/10 bg-elev-1/60 p-4">
            <p className="text-[0.6875rem] font-semibold uppercase tracking-wider text-low">
              VDA receipts taxed at slab rate (Section 56(2)(x))
            </p>
            <p className="mt-2 font-mono text-lg font-semibold tabular-figures text-warn">
              {formatCurrency(receiptIncome as number, currency)}
            </p>
            <p className="mt-1 text-[0.6875rem] leading-relaxed text-low">
              Staking / airdrops / gifts received this year are income from other sources,
              taxed at your slab rate — separate from the 30% transfer estimate above.
            </p>
          </div>
        )}

        <p className="text-xs leading-relaxed text-low" data-testid="tax-estimate-note">
          {TAX_ESTIMATE_NO_OFFSET_NOTE} Surcharge and slab-rate effects are out of scope —
          confirm final figures with your tax professional.
        </p>
      </CardContent>
    </Card>
  );
}
