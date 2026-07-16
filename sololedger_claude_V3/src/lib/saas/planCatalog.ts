import type { LucideIcon } from 'lucide-react';
import { Sparkles, Zap, Crown, Building2, Rocket, ShieldCheck } from 'lucide-react';
import type { PlanId } from './plans';

export type { PlanId };
/** @deprecated Use PlanId — kept as an alias so existing imports keep compiling. */
export type PaidPlanId = PlanId;

export type PlanDisplay = {
  id: PlanId;
  name: string;
  /** Formatted INR price, e.g. "₹0", "₹1,799". */
  price: string;
  period: string;
  /** Unit-allowance label shown on the card, e.g. "Up to 500 events". */
  limit: string;
  tagline: string;
  icon: LucideIcon;
  accent: string;
  featured?: boolean;
  contactOnly?: boolean;
};

/**
 * Six India tiers, matching /code/.plans/designs/aurora-pricing-final.html.
 * Billing unit = taxable disposals + income events (per tax year, INR).
 * Standard is the MOST POPULAR / featured tier. No "Unlimited" anywhere —
 * Enterprise meters prepaid packs above 10,000 events.
 */
export const PLAN_CATALOG: PlanDisplay[] = [
  {
    id: 'local',
    name: 'Local',
    price: '₹0',
    period: '',
    limit: 'Up to 100 events',
    tagline: 'Free forever · 100% on-device · no account',
    icon: ShieldCheck,
    accent: 'from-teal to-blue'
  },
  {
    id: 'starter',
    name: 'Starter',
    price: '₹499',
    period: '/year',
    limit: 'Up to 500 events',
    tagline: 'One clean, filing-ready report for a lighter trading year.',
    icon: Zap,
    accent: 'from-violet to-blue'
  },
  {
    id: 'standard',
    name: 'Standard',
    price: '₹1,799',
    period: '/year',
    limit: 'Up to 2,000 events',
    tagline: 'The complete India filing kit for an active trader.',
    icon: Sparkles,
    accent: 'from-violet to-blue',
    featured: true
  },
  {
    id: 'pro',
    name: 'Pro',
    price: '₹3,999',
    period: '/year',
    limit: 'Up to 5,000 events',
    tagline: 'For heavy traders with derivatives and multi-year history.',
    icon: Crown,
    accent: 'from-elev-1 to-blue'
  },
  {
    id: 'investor',
    name: 'Investor',
    price: '₹6,999',
    period: '/year',
    limit: 'Up to 10,000 events',
    tagline: 'High-volume portfolios with a CA-ready pack and the AI advisor.',
    icon: Building2,
    accent: 'from-violet to-teal'
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    price: '₹6,999+',
    period: '/year',
    limit: '10,000 included, then metered',
    tagline: 'For CAs & firms filing at scale — metered at ₹599 per extra 1,000.',
    icon: Rocket,
    accent: 'from-blue to-violet',
    contactOnly: true
  }
];

export const SELECTED_PLAN_KEY = 'sololedger_selected_plan';
