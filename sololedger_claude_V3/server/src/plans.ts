export type PlanId =
  | 'starter'
  | 'standard'
  | 'pro'
  | 'small_business'
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
    priceYearlyUsd: 50,
    txLimit: 100,
    description: 'Up to 100 transactions per year'
  },
  standard: {
    id: 'standard',
    name: 'Standard',
    priceYearlyUsd: 100,
    txLimit: 500,
    description: 'Up to 500 transactions per year'
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceYearlyUsd: 500,
    txLimit: 1000,
    description: 'Up to 1,000 transactions per year'
  },
  small_business: {
    id: 'small_business',
    name: 'Small business',
    priceYearlyUsd: 1500,
    txLimit: 5000,
    description: 'Up to 5,000 transactions per year'
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    priceYearlyUsd: 0,
    txLimit: UNLIMITED_TX,
    description: 'Unlimited transactions'
  }
};

export const TRIAL_TX_LIMIT = 25;

export function isUnlimitedTxLimit(limit: number): boolean {
  return limit >= UNLIMITED_TX;
}

export function getPlanTxLimit(plan: PlanId, customTxLimit?: number | null): number {
  if (customTxLimit != null && customTxLimit > 0) return customTxLimit;
  if (plan === 'trial') return TRIAL_TX_LIMIT;
  return PLANS[plan].txLimit;
}
