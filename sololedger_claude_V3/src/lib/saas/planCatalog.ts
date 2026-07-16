import type { LucideIcon } from 'lucide-react';
import { Sparkles, Zap, Crown, Building2, Rocket } from 'lucide-react';

export type PaidPlanId = 'starter' | 'standard' | 'pro' | 'investor' | 'enterprise';

export type PlanDisplay = {
  id: PaidPlanId;
  name: string;
  price: string;
  period: string;
  limit: string;
  tagline: string;
  icon: LucideIcon;
  accent: string;
  featured?: boolean;
  contactOnly?: boolean;
};

export const PLAN_CATALOG: PlanDisplay[] = [
  {
    id: 'starter',
    name: 'Starter',
    price: '$0',
    period: '',
    limit: '100 tx',
    tagline: 'Start for free',
    icon: Zap,
    accent: 'from-violet to-blue'
  },
  {
    id: 'standard',
    name: 'Standard',
    price: '$100',
    period: '/year',
    limit: '1,000 tx',
    tagline: 'Active portfolios',
    icon: Sparkles,
    accent: 'from-violet to-blue',
    featured: true
  },
  {
    id: 'pro',
    name: 'Pro',
    price: '$200',
    period: '/year',
    limit: '3,000 tx',
    tagline: 'Power users',
    icon: Crown,
    accent: 'from-elev-1 to-blue'
  },
  {
    id: 'investor',
    name: 'Investor',
    price: '$500',
    period: '/year',
    limit: '30,000 tx',
    tagline: 'High-volume wallets',
    icon: Building2,
    accent: 'from-violet-600 to-blue'
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    price: '$3,000',
    period: '/year',
    limit: 'Unlimited',
    tagline: 'Teams & unlimited volume',
    icon: Rocket,
    accent: 'from-amber-500 to-orange-600'
  }
];

export const SELECTED_PLAN_KEY = 'sololedger_selected_plan';
