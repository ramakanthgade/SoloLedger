export type PlanId = 'starter' | 'standard' | 'pro' | 'trial';

export interface Plan {
  id: PlanId;
  name: string;
  priceYearlyUsd: number;
  txLimit: number;
  description: string;
}

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
  }
};

export const TRIAL_TX_LIMIT = 25;

export function getPlanTxLimit(plan: PlanId, customTxLimit?: number | null): number {
  if (customTxLimit != null && customTxLimit > 0) return customTxLimit;
  if (plan === 'trial') return TRIAL_TX_LIMIT;
  return PLANS[plan].txLimit;
}
