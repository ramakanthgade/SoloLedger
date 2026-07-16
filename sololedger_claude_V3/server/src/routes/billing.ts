import { Router } from 'express';
import Stripe from 'stripe';
import { authMiddleware, getUserFromRequest, type AuthedRequest } from '../auth.js';
import { findUserById, upsertUser } from '../store.js';
import {
  ENTERPRISE_BASE_UNITS,
  enterprisePriceInr,
  enterpriseUnitsForPacks,
  PLANS,
  type PlanId
} from '../plans.js';

export const billingRouter = Router();

function getStripe(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) return null;
  return new Stripe(key);
}

/** Paid, purchasable plans (the free `local` tier is never checked out). */
const PAID_PLANS: PlanId[] = ['starter', 'standard', 'pro', 'investor', 'enterprise'];

const PRICE_MAP: Partial<Record<PlanId, string | undefined>> = {
  starter: process.env.STRIPE_PRICE_STARTER,
  standard: process.env.STRIPE_PRICE_STANDARD,
  pro: process.env.STRIPE_PRICE_PRO,
  investor: process.env.STRIPE_PRICE_INVESTOR,
  enterprise: process.env.STRIPE_PRICE_ENTERPRISE
};

function isPaidPlan(plan: unknown): plan is PlanId {
  return typeof plan === 'string' && PAID_PLANS.includes(plan as PlanId);
}

/**
 * Resolve the purchased Enterprise allowance from the requested extra packs.
 * Each pack = 1,000 events above the 10,000 base; price = ₹6,999 + N × ₹599.
 */
export function resolveEnterprisePurchase(extraPacks: unknown): {
  includedUnits: number;
  priceInr: number;
  overageBlocks: number;
} {
  const packs = Number.isFinite(Number(extraPacks)) ? Math.max(0, Math.floor(Number(extraPacks))) : 0;
  const includedUnits = enterpriseUnitsForPacks(packs);
  return { includedUnits, priceInr: enterprisePriceInr(includedUnits), overageBlocks: packs };
}

billingRouter.get('/plans', (_req, res) => {
  res.json({ plans: Object.values(PLANS) });
});

billingRouter.post('/checkout', authMiddleware, async (req: AuthedRequest, res) => {
  const stripe = getStripe();
  if (!stripe) {
    res.status(503).json({
      error: 'Stripe not configured — contact admin or use manual subscription activation',
      plans: Object.values(PLANS)
    });
    return;
  }

  const plan = req.body?.plan as PlanId;
  if (!isPaidPlan(plan)) {
    res.status(400).json({ error: 'Invalid plan' });
    return;
  }

  const priceId = PRICE_MAP[plan];
  if (!priceId) {
    res.status(503).json({ error: `Stripe price not configured for plan: ${plan}` });
    return;
  }

  const user = getUserFromRequest(req)!;
  const origin = req.headers.origin ?? process.env.CORS_ORIGIN?.split(',')[0] ?? 'http://localhost:5173';

  // Enterprise = prepaid allowance packs: the buyer picks N extra 1,000-event
  // packs at checkout; the issued license encodes the purchased allowance in
  // its signed includedUnits. `quantity` prices the base + N overage packs.
  const enterprise = plan === 'enterprise' ? resolveEnterprisePurchase(req.body?.extraPacks) : null;
  const overageQty = enterprise ? enterprise.overageBlocks : 0;
  const overagePriceId = process.env.STRIPE_PRICE_ENTERPRISE_PACK;

  const line_items: Stripe.Checkout.SessionCreateParams.LineItem[] = [
    { price: priceId, quantity: 1 }
  ];
  if (enterprise && overageQty > 0 && overagePriceId) {
    line_items.push({ price: overagePriceId, quantity: overageQty });
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer_email: user.email,
    line_items,
    success_url: `${origin}/SoloLedger/?billing=success`,
    cancel_url: `${origin}/SoloLedger/?billing=canceled`,
    metadata: {
      userId: user.id,
      plan,
      includedUnits: String(enterprise ? enterprise.includedUnits : PLANS[plan].includedUnits),
      overageBlocks: String(overageQty)
    }
  });

  res.json({ url: session.url });
});

/** activate-dev is a dev/test-only escape hatch — never available in production. */
export function isDevActivateBlocked(): boolean {
  return process.env.NODE_ENV === 'production';
}

/** Dev / manual activation when Stripe is not wired up */
billingRouter.post('/activate-dev', authMiddleware, (req: AuthedRequest, res) => {
  if (isDevActivateBlocked()) {
    res.status(403).json({ error: 'Not available in production' });
    return;
  }
  const plan = req.body?.plan as PlanId;
  if (!isPaidPlan(plan)) {
    res.status(400).json({ error: 'Invalid plan' });
    return;
  }
  const user = getUserFromRequest(req)!;
  const record = findUserById(user.id);
  if (!record) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  const enterprise = plan === 'enterprise' ? resolveEnterprisePurchase(req.body?.extraPacks) : null;
  upsertUser({
    ...record,
    plan,
    overageBlocks: enterprise ? enterprise.overageBlocks : record.overageBlocks,
    subscriptionStatus: 'active',
    subscriptionExpiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
  });
  res.json({ ok: true, plan });
});

export async function handleStripeWebhook(req: import('express').Request, res: import('express').Response): Promise<void> {
  const stripe = getStripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripe || !secret) {
    res.status(503).send('Stripe webhook not configured');
    return;
  }

  const sig = req.headers['stripe-signature'];
  if (!sig) {
    res.status(400).send('Missing stripe-signature');
    return;
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    res.status(400).send(`Webhook error: ${err instanceof Error ? err.message : 'unknown'}`);
    return;
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    const userId = session.metadata?.userId;
    const plan = session.metadata?.plan as PlanId | undefined;
    if (userId && isPaidPlan(plan)) {
      const user = findUserById(userId);
      if (user) {
        const overageBlocks = Number(session.metadata?.overageBlocks ?? '0');
        upsertUser({
          ...user,
          plan,
          overageBlocks:
            plan === 'enterprise' && Number.isFinite(overageBlocks) && overageBlocks > 0
              ? overageBlocks
              : user.overageBlocks,
          subscriptionStatus: 'active',
          subscriptionExpiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
          stripeCustomerId: typeof session.customer === 'string' ? session.customer : user.stripeCustomerId
        });
      }
    }
  }

  res.json({ received: true });
}
