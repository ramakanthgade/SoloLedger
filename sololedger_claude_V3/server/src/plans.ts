export type PlanId =
  | 'starter'
  | 'standard'
  | 'pro'
  | 'investor'
  | 'enterprise'
  | 'trial';

export interface Plan {
  id: Exclude<PlanId, 'trial'>;
  name: string;
  priceYearlyUsd: number;
  txLimit: number;
  description: string;
}

/** Sentinel value — admin & enterprise plans are effectively unlimited. */
export const UNLIMITED_TX = 9_999_999;

export const PLANS: Record<Exclude<PlanId, 'trial'>, Plan> = {
  starter: {
    id: 'starter',
    name: 'Starter',
    priceYearlyUsd: 0,
    txLimit: 100,
    description: 'Free — up to 100 transactions per year'
  },
  standard: {
    id: 'standard',
    name: 'Standard',
    priceYearlyUsd: 100,
    txLimit: 1000,
    description: 'Up to 1,000 transactions per year'
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceYearlyUsd: 200,
    txLimit: 3000,
    description: 'Up to 3,000 transactions per year'
  },
  investor: {
    id: 'investor',
    name: 'Investor',
    priceYearlyUsd: 500,
    txLimit: 30000,
    description: 'Up to 30,000 transactions per year'
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    priceYearlyUsd: 3000,
    txLimit: UNLIMITED_TX,
    description: 'Unlimited transactions'
  }
};

/** @deprecated Legacy trial users — treated as Starter limits. */
export const TRIAL_TX_LIMIT = 100;

export function isUnlimitedTxLimit(limit: number): boolean {
  return limit >= UNLIMITED_TX;
}

export function getPlanTxLimit(plan: PlanId, customTxLimit?: number | null): number {
  if (customTxLimit != null && customTxLimit > 0) return customTxLimit;
  if (plan === 'trial') return PLANS.starter.txLimit;
  return PLANS[plan].txLimit;
}
