import { Router } from 'express';
import { resolveApiKey } from '../apiKeys.js';
import { getServerConfig } from '../store.js';
import { getBinanceGatewayConfig } from './exchangeGateway.js';

export const configRouter = Router();

/** Public subscriber config — no API keys, only feature toggles controlled by admin. */
configRouter.get('/public', (_req, res) => {
  const config = getServerConfig();
  const openrouterConfigured = Boolean(resolveApiKey('openrouterApiKey'));
  res.json({
    priceApiEnabled: config.priceApiEnabled,
    rpcLookupEnabled: config.rpcLookupEnabled,
    aiAdvisorEnabled: config.aiAdvisorEnabled && openrouterConfigured,
    exchangeSyncEnabled: config.exchangeSyncEnabled ?? false,
    // URL only (never the secret) — the client uses it to know Binance calls
    // should go through the geo-friendly gateway instead of the relay tunnel.
    binanceGatewayUrl: getBinanceGatewayConfig()?.url ?? null
  });
});
