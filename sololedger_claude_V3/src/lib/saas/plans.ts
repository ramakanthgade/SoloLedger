/** Client-side plan helpers — keep in sync with server/src/plans.ts */

export type PlanId =
  | 'starter'
  | 'standard'
  | 'pro'
  | 'investor'
  | 'enterprise'
  | 'trial';

export const UNLIMITED_TX = 9_999_999;

export function isUnlimitedTxLimit(limit: number): boolean {
  return limit >= UNLIMITED_TX;
}

export function formatTxLimit(limit: number): string {
  return isUnlimitedTxLimit(limit) ? 'Unlimited' : limit.toLocaleString();
}

export function formatPlanLabel(plan: string): string {
  return plan.replace(/_/g, ' ');
}
