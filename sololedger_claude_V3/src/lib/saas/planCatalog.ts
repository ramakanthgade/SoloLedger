import type { LucideIcon } from 'lucide-react';
import { Sparkles, Zap, Crown, Building2, Rocket } from 'lucide-react';

export type PaidPlanId = 'starter' | 'standard' | 'pro' | 'small_business' | 'enterprise';

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
    price: '$50',
    period: '/year',
    limit: '100 tx',
    tagline: 'Solo traders getting started',
    icon: Zap,
    accent: 'from-teal-500 to-emerald-600'
  },
  {
    id: 'standard',
    name: 'Standard',
    price: '$100',
    period: '/year',
    limit: '500 tx',
    tagline: 'Active portfolios',
    icon: Sparkles,
    accent: 'from-emerald-500 to-teal-600',
    featured: true
  },
  {
    id: 'pro',
    name: 'Pro',
    price: '$500',
    period: '/year',
    limit: '1,000 tx',
    tagline: 'Power users & pros',
    icon: Crown,
    accent: 'from-navy to-teal-700'
  },
  {
    id: 'small_business',
    name: 'Small business',
    price: '$1,500',
    period: '/year',
    limit: '5,000 tx',
    tagline: 'High-volume wallets',
    icon: Building2,
    accent: 'from-violet-600 to-teal-600'
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    price: 'Contact',
    period: ' us',
    limit: 'Unlimited',
    tagline: 'Teams & unlimited volume',
    icon: Rocket,
    accent: 'from-amber-500 to-orange-600',
    contactOnly: true
  }
];

export const SELECTED_PLAN_KEY = 'sololedger_selected_plan';
