import {
  apiKeysStatus,
  deleteStoredApiKey,
  getStoredApiKeys,
  resolveApiKey,
  updateStoredApiKeys,
  type ApiKeyName
} from '../apiKeys.js';
import { Router } from 'express';
import {
  adminMiddleware,
  authMiddleware,
  getUserFromRequest,
  isSubscriptionActive,
  type AuthedRequest
} from '../auth.js';
import { getServerConfig, updateServerConfig } from '../store.js';
import { getStore, upsertUser, findUserById, type UserRecord } from '../store.js';
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
    aiAdvisorEnabled: patch.aiAdvisorEnabled ?? getServerConfig().aiAdvisorEnabled,
    exchangeSyncEnabled: patch.exchangeSyncEnabled ?? getServerConfig().exchangeSyncEnabled
  });
  res.json({ config });
});

adminRouter.get('/users', (_req, res) => {
  const users = getStore().users.map(publicUser);
  res.json({ users });
});

adminRouter.get('/api-keys', (_req, res) => {
  const names: ApiKeyName[] = [
    'alchemyApiKey',
    'coingeckoApiKey',
    'heliusApiKey',
    'moralisApiKey',
    'birdeyeApiKey',
    'novesApiKey',
    'openrouterApiKey',
    'etherscanApiKey'
  ];
  const effective = Object.fromEntries(names.map((n) => [n, resolveApiKey(n)])) as Record<ApiKeyName, string | undefined>;
  res.json({ keys: effective, stored: getStoredApiKeys(), configured: apiKeysStatus() });
});

adminRouter.put('/api-keys', (req, res) => {
  const keys = updateStoredApiKeys(req.body ?? {});
  res.json({ keys, configured: apiKeysStatus() });
});

adminRouter.delete('/api-keys/:name', (req, res) => {
  const name = req.params.name as ApiKeyName;
  const valid: ApiKeyName[] = [
    'alchemyApiKey',
    'coingeckoApiKey',
    'heliusApiKey',
    'moralisApiKey',
    'birdeyeApiKey',
    'novesApiKey',
    'openrouterApiKey',
    'etherscanApiKey'
  ];
  if (!valid.includes(name)) {
    res.status(400).json({ error: 'Unknown API key name' });
    return;
  }
  const keys = deleteStoredApiKey(name);
  res.json({ keys, configured: apiKeysStatus() });
});

adminRouter.get('/api-keys-status', (_req, res) => {
  res.json(apiKeysStatus());
});

adminRouter.patch('/users/:id', (req, res) => {
  const user = findUserById(req.params.id);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  const body = req.body ?? {};
  const updated: UserRecord = {
    ...user,
    plan: body.plan ?? user.plan,
    subscriptionStatus: body.subscriptionStatus ?? user.subscriptionStatus,
    customIncludedUnits:
      body.customIncludedUnits === null || body.customIncludedUnits === ''
        ? undefined
        : body.customIncludedUnits != null
          ? Number(body.customIncludedUnits)
          : user.customIncludedUnits,
    overageBlocks:
      body.overageBlocks === null || body.overageBlocks === ''
        ? undefined
        : body.overageBlocks != null
          ? Number(body.overageBlocks)
          : user.overageBlocks
  };
  upsertUser(updated);
  res.json({ user: publicUser(updated) });
});

adminRouter.post('/check-subscription', authMiddleware, (req: AuthedRequest, res) => {
  const user = getUserFromRequest(req);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json({
    active: isSubscriptionActive(user),
    plan: user.plan
  });
});
