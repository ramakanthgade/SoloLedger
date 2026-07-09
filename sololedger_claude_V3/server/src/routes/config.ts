import { Router } from 'express';
import { getServerConfig } from '../store.js';

export const configRouter = Router();

/** Public subscriber config — no API keys, only feature toggles controlled by admin. */
configRouter.get('/public', (_req, res) => {
  const config = getServerConfig();
  res.json({
    priceApiEnabled: config.priceApiEnabled,
    rpcLookupEnabled: config.rpcLookupEnabled,
    aiAdvisorEnabled: config.aiAdvisorEnabled
  });
});
