import { Router } from 'express';
import {
  adminMiddleware,
  authMiddleware,
  getUserFromRequest,
  isSubscriptionActive,
  type AuthedRequest
} from '../auth.js';
import { getServerConfig, updateServerConfig } from '../store.js';
import { getStore } from '../store.js';
import { publicUser } from '../auth.js';

export const adminRouter = Router();

adminRouter.use(authMiddleware, adminMiddleware);

adminRouter.get('/config', (_req, res) => {
  res.json({ config: getServerConfig() });
});

adminRouter.put('/config', (req, res) => {
  const patch = req.body ?? {};
  const config = updateServerConfig({
    priceApiEnabled: patch.priceApiEnabled ?? getServerConfig().priceApiEnabled,
    rpcLookupEnabled: patch.rpcLookupEnabled ?? getServerConfig().rpcLookupEnabled,
    aiAdvisorEnabled: patch.aiAdvisorEnabled ?? getServerConfig().aiAdvisorEnabled
  });
  res.json({ config });
});

adminRouter.get('/users', (_req, res) => {
  const users = getStore().users.map(publicUser);
  res.json({ users });
});

adminRouter.get('/api-keys-status', (_req, res) => {
  res.json({
    alchemy: Boolean(process.env.ALCHEMY_API_KEY),
    coingecko: Boolean(process.env.COINGECKO_API_KEY),
    helius: Boolean(process.env.HELIUS_API_KEY),
    moralis: Boolean(process.env.MORALIS_API_KEY),
    birdeye: Boolean(process.env.BIRDEYE_API_KEY),
    noves: Boolean(process.env.NOVES_API_KEY),
    openrouter: Boolean(process.env.OPENROUTER_API_KEY),
    etherscan: Boolean(process.env.ETHERSCAN_API_KEY)
  });
});

adminRouter.post('/check-subscription', authMiddleware, (req: AuthedRequest, res) => {
  const user = getUserFromRequest(req);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json({
    active: isSubscriptionActive(user),
    plan: user.plan,
    txLimit: user.plan === 'trial' ? 25 : undefined
  });
});
