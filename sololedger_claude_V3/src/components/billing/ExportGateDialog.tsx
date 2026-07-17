/**
 * Export-gate blocking dialog + `useExportGuard` hook (D6 fix).
 *
 * This is the SINGLE production wrapper that enforces the billing cap on every
 * real export / report-generation path. Before any blob or PDF is generated a
 * call site wraps its export function in `runGuarded(...)`: the hook resolves
 * the active license allowance, counts the on-device billable units, and runs
 * {@link evaluateExportGate}. When over the cap it BLOCKS (nothing is written
 * to disk) and shows this dialog with the upgrade CTA — there is never any
 * silent truncation. When within the cap the export runs unchanged.
 *
 * Enforcement is 100% on-device; the optional `auth` snapshot only supplies the
 * SaaS-plan allowance when a signed on-device license is absent.
 */
import { useState } from 'react';
import type { Disposal, Jurisdiction, Transaction } from '@/types/transaction';
import { countBillableUnits } from '@/lib/billing/usage';
import { evaluateExportGate, type ExportGateResult } from '@/lib/billing/gate';
import { currentAllowance, resolveLicenseState, type AuthSnapshot } from '@/lib/features';
import { SELECTED_PLAN_KEY } from '@/lib/saas/planCatalog';
import { formatUnitLimit, type PlanId } from '@/lib/saas/plans';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/button';

export interface ExportGuardParams {
  /** All computed disposals (FY filtering happens inside the counter). */
  disposals: Disposal[];
  /** Raw transactions — income/derivative income events are counted too. */
  transactions: Transaction[];
  fy: number;
  jurisdiction: Jurisdiction;
  /**
   * Optional SaaS auth snapshot. Supplies the plan allowance when there is no
   * verified on-device license. Omit in local mode (free `local` tier).
   */
  auth?: AuthSnapshot | null;
}

export interface ExportGuard {
  /**
   * Run `exportFn` only when the billable-unit count is within the allowance.
   * Over the cap: blocks (never calls `exportFn`) and opens the gate dialog.
   */
  runGuarded: (exportFn: () => void | Promise<void>) => Promise<void>;
  /** The blocking dialog element to render once per call site. */
  gateDialog: React.ReactNode;
  /** True while a block is being shown (exposed for tests / disabling UI). */
  blocked: boolean;
}

/** Map the resolved license tier to the PlanId the gate reasons about. */
function gateTier(tier: 'free' | PlanId): PlanId {
  return tier === 'free' ? 'local' : tier;
}

export function useExportGuard(params: ExportGuardParams): ExportGuard {
  const [result, setResult] = useState<ExportGateResult | null>(null);

  const runGuarded = async (exportFn: () => void | Promise<void>) => {
    const state = await resolveLicenseState(params.auth ?? null);
    const units = countBillableUnits(
      params.disposals,
      params.transactions,
      params.fy,
      params.jurisdiction
    );
    const gate = evaluateExportGate(units, currentAllowance(state), gateTier(state.tier));
    if (gate.allowed) {
      await exportFn();
      return;
    }
    setResult(gate);
  };

  const onSelectPlan = () => {
    const cta = result?.upgradeCta;
    if (cta?.action === 'upgrade_plan' && cta.suggestedPlan) {
      try {
        sessionStorage.setItem(SELECTED_PLAN_KEY, cta.suggestedPlan);
      } catch {
        /* sessionStorage may be unavailable — the message still guides the user. */
      }
    }
    setResult(null);
  };

  const gateDialog = (
    <ExportGateDialog result={result} onClose={() => setResult(null)} onSelectPlan={onSelectPlan} />
  );

  return { runGuarded, gateDialog, blocked: result != null };
}

interface ExportGateDialogProps {
  result: ExportGateResult | null;
  onClose: () => void;
  onSelectPlan: () => void;
}

/** The blocked-export modal — headline, plain-language reason, and CTA. */
export function ExportGateDialog({ result, onClose, onSelectPlan }: ExportGateDialogProps) {
  const open = result != null && !result.allowed;
  const cta = result?.upgradeCta;
  const isBuyPack = cta?.action === 'buy_pack';

  return (
    <Dialog open={open} onClose={onClose} label={cta?.title ?? 'Export limit reached'}>
      <div data-testid="export-gate-dialog">
        <h2 className="text-sm font-semibold text-hi">{cta?.title ?? 'Export limit reached'}</h2>
        {result && (
          <p className="mt-2 text-xs leading-relaxed text-mid">{cta?.message}</p>
        )}
        {result && (
          <p className="mt-3 text-[0.6875rem] text-low">
            This report covers {formatUnitLimit(result.units)} taxable disposals + income events —{' '}
            {formatUnitLimit(result.overageUnits)} over your {formatUnitLimit(result.allowance)}
            -event allowance. Nothing was truncated or exported.
          </p>
        )}
        <p className="mt-3 text-[0.6875rem] text-low">
          Open Settings → Subscription to {isBuyPack ? 'buy a larger prepaid pack' : 'upgrade your plan'}
          , or paste a license key that covers this many events.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Not now
          </Button>
          <Button size="sm" onClick={onSelectPlan}>
            {isBuyPack ? 'Buy a pack' : 'See plans'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
