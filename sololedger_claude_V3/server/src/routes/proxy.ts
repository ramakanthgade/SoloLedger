import { Router, type Request, type Response } from 'express';
import {
  authMiddleware,
  getUserFromRequest,
  isSubscriptionActive,
  type AuthedRequest
} from '../auth.js';
import { getServerConfig } from '../store.js';
import { resolveApiKey } from '../apiKeys.js';

export const proxyRouter = Router();

proxyRouter.use(authMiddleware);

function requireActiveSubscription(req: AuthedRequest, res: Response): boolean {
  const user = getUserFromRequest(req);
  if (!user) {
    res.status(401).json({ error: 'User not found' });
    return false;
  }
  if (!isSubscriptionActive(user)) {
    res.status(402).json({ error: 'Subscription inactive — renew to continue using network features' });
    return false;
  }
  return true;
}

async function forward(
  targetUrl: string,
  req: Request,
  res: Response,
  extraHeaders: Record<string, string> = {}
): Promise<void> {
  const method = req.method.toUpperCase();
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...extraHeaders
  };
  if (req.headers['content-type']) {
    headers['content-type'] = String(req.headers['content-type']);
  }

  const init: RequestInit = { method, headers };
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = JSON.stringify(req.body ?? {});
  }

  const upstream = await fetch(targetUrl, init);
  const contentType = upstream.headers.get('content-type') ?? 'application/json';
  res.status(upstream.status);
  res.setHeader('content-type', contentType);
  const text = await upstream.text();
  res.send(text);
}

/** Alchemy JSON-RPC — POST /api/proxy/alchemy/:network */
proxyRouter.post('/alchemy/:network', async (req: AuthedRequest, res) => {
  if (!requireActiveSubscription(req, res)) return;
  const config = getServerConfig();
  if (!config.rpcLookupEnabled) {
    res.status(403).json({ error: 'Wallet lookup is disabled by admin' });
    return;
  }
  const key = resolveApiKey('alchemyApiKey');
  if (!key) {
    res.status(503).json({ error: 'Alchemy API key not configured on server' });
    return;
  }
  const network = req.params.network;
  await forward(`https://${network}.g.alchemy.com/v2/${key}`, req, res);
});

/** CoinGecko — GET/POST /api/proxy/coingecko/* */
proxyRouter.all('/coingecko/*', async (req: AuthedRequest, res) => {
  if (!requireActiveSubscription(req, res)) return;
  const config = getServerConfig();
  if (!config.priceApiEnabled) {
    res.status(403).json({ error: 'Price lookup is disabled by admin' });
    return;
  }
  const key = resolveApiKey('coingeckoApiKey');
  const base = key ? 'https://pro-api.coingecko.com/api/v3' : 'https://api.coingecko.com/api/v3';
  const suffix = req.params[0] ?? '';
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const headers: Record<string, string> = {};
  if (key) headers['x-cg-pro-api-key'] = key;
  await forward(`${base}/${suffix}${qs}`, req, res, headers);
});

/** Helius — GET /api/proxy/helius/* */
proxyRouter.all('/helius/*', async (req: AuthedRequest, res) => {
  if (!requireActiveSubscription(req, res)) return;
  const config = getServerConfig();
  if (!config.rpcLookupEnabled) {
    res.status(403).json({ error: 'Wallet lookup is disabled by admin' });
    return;
  }
  const key = resolveApiKey('heliusApiKey');
  if (!key) {
    res.status(503).json({ error: 'Helius API key not configured on server' });
    return;
  }
  const suffix = req.params[0] ?? '';
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  await forward(`https://mainnet.helius-rpc.com/${suffix}${qs}?api-key=${key}`, req, res);
});

/** Moralis — GET/POST /api/proxy/moralis/* */
proxyRouter.all('/moralis/*', async (req: AuthedRequest, res) => {
  if (!requireActiveSubscription(req, res)) return;
  const config = getServerConfig();
  if (!config.rpcLookupEnabled) {
    res.status(403).json({ error: 'Wallet lookup is disabled by admin' });
    return;
  }
  const key = resolveApiKey('moralisApiKey');
  if (!key) {
    res.status(503).json({ error: 'Moralis API key not configured on server' });
    return;
  }
  const suffix = req.params[0] ?? '';
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  await forward(`https://deep-index.moralis.io/${suffix}${qs}`, req, res, {
    'X-API-Key': key
  });
});

/** Birdeye — GET /api/proxy/birdeye/* */
proxyRouter.all('/birdeye/*', async (req: AuthedRequest, res) => {
  if (!requireActiveSubscription(req, res)) return;
  const config = getServerConfig();
  if (!config.priceApiEnabled) {
    res.status(403).json({ error: 'Price lookup is disabled by admin' });
    return;
  }
  const key = resolveApiKey('birdeyeApiKey');
  if (!key) {
    res.status(503).json({ error: 'Birdeye API key not configured on server' });
    return;
  }
  const suffix = req.params[0] ?? '';
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  await forward(`https://public-api.birdeye.so/${suffix}${qs}`, req, res, {
    'X-API-KEY': key,
    'x-chain': 'solana'
  });
});

/** Noves — POST /api/proxy/noves/* */
proxyRouter.all('/noves/*', async (req: AuthedRequest, res) => {
  if (!requireActiveSubscription(req, res)) return;
  const key = resolveApiKey('novesApiKey');
  if (!key) {
    res.status(503).json({ error: 'Noves API key not configured on server' });
    return;
  }
  const suffix = req.params[0] ?? '';
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  await forward(`https://translate.noves.fi/${suffix}${qs}`, req, res, {
    apiKey: key
  });
});

/** OpenRouter — POST /api/proxy/openrouter/* */
proxyRouter.all('/openrouter/*', async (req: AuthedRequest, res) => {
  if (!requireActiveSubscription(req, res)) return;
  const config = getServerConfig();
  if (!config.aiAdvisorEnabled) {
    res.status(403).json({ error: 'AI Advisor is disabled by admin' });
    return;
  }
  const key = resolveApiKey('openrouterApiKey');
  if (!key) {
    res.status(503).json({ error: 'OpenRouter API key not configured on server' });
    return;
  }
  const suffix = req.params[0] ?? '';
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  await forward(`https://openrouter.ai/api/v1/${suffix}${qs}`, req, res, {
    Authorization: `Bearer ${key}`,
    'HTTP-Referer': process.env.CORS_ORIGIN?.split(',')[0] ?? 'https://sololedger.app',
    'X-Title': 'SoloLedger'
  });
});

/** Etherscan family — GET /api/proxy/etherscan */
proxyRouter.get('/etherscan', async (req: AuthedRequest, res) => {
  if (!requireActiveSubscription(req, res)) return;
  const key = resolveApiKey('etherscanApiKey');
  if (!key) {
    res.status(503).json({ error: 'Etherscan API key not configured on server' });
    return;
  }
  const qs = new URLSearchParams(req.query as Record<string, string>);
  qs.set('apikey', key);
  await forward(`https://api.etherscan.io/api?${qs}`, req, res);
});

/** Blockstream — free, no key; still auth-gated for metering */
proxyRouter.get('/blockstream/*', async (req: AuthedRequest, res) => {
  if (!requireActiveSubscription(req, res)) return;
  const suffix = req.params[0] ?? '';
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  await forward(`https://blockstream.info/api/${suffix}${qs}`, req, res);
});

/** Alchemy Prices API — POST /api/proxy/alchemy-prices/* */
proxyRouter.post('/alchemy-prices/*', async (req: AuthedRequest, res) => {
  if (!requireActiveSubscription(req, res)) return;
  const config = getServerConfig();
  if (!config.priceApiEnabled) {
    res.status(403).json({ error: 'Price lookup is disabled by admin' });
    return;
  }
  const key = resolveApiKey('alchemyApiKey');
  if (!key) {
    res.status(503).json({ error: 'Alchemy API key not configured on server' });
    return;
  }
  const suffix = req.params[0] ?? '';
  await forward(`https://api.g.alchemy.com/prices/v1/${key}/${suffix}`, req, res);
});

/** Blockscout — free Ethereum explorer */
proxyRouter.get('/blockscout/*', async (req: AuthedRequest, res) => {
  if (!requireActiveSubscription(req, res)) return;
  const suffix = req.params[0] ?? '';
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  await forward(`https://eth.blockscout.com/api/v2/${suffix}${qs}`, req, res);
});
