import { Router } from 'express';
import Stripe from 'stripe';
import { authMiddleware, getUserFromRequest, type AuthedRequest } from '../auth.js';
import { findUserById, upsertUser } from '../store.js';
import { PLANS, type PlanId } from '../plans.js';

export const billingRouter = Router();

function getStripe(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) return null;
  return new Stripe(key);
}

const PRICE_MAP: Partial<Record<PlanId, string | undefined>> = {
  standard: process.env.STRIPE_PRICE_STANDARD,
  pro: process.env.STRIPE_PRICE_PRO,
  investor: process.env.STRIPE_PRICE_INVESTOR,
  enterprise: process.env.STRIPE_PRICE_ENTERPRISE
};

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
  if (!plan || plan === 'trial' || plan === 'starter' || !(plan in PLANS)) {
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

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer_email: user.email,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${origin}/SoloLedger/?billing=success`,
    cancel_url: `${origin}/SoloLedger/?billing=canceled`,
    metadata: { userId: user.id, plan }
  });

  res.json({ url: session.url });
});

/** Dev / manual activation when Stripe is not wired up */
billingRouter.post('/activate-dev', authMiddleware, (req: AuthedRequest, res) => {
  if (process.env.NODE_ENV === 'production') {
    res.status(403).json({ error: 'Not available in production' });
    return;
  }
  const plan = req.body?.plan as PlanId;
  if (!plan || plan === 'trial') {
    res.status(400).json({ error: 'Invalid plan' });
    return;
  }
  const user = getUserFromRequest(req)!;
  const record = findUserById(user.id);
  if (!record) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  upsertUser({
    ...record,
    plan,
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
    if (userId && plan && plan !== 'trial') {
      const user = findUserById(userId);
      if (user) {
        upsertUser({
          ...user,
          plan,
          subscriptionStatus: 'active',
          subscriptionExpiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
          stripeCustomerId: typeof session.customer === 'string' ? session.customer : user.stripeCustomerId
        });
      }
    }
  }

  res.json({ received: true });
}
