import { resolveApiKey, type ApiKeyName } from './apiKeys.js';

/**
 * Log redaction for proxy paths.
 *
 * Provider URLs embed API keys (Alchemy `https://…g.alchemy.com/v2/<key>`,
 * Helius `?api-key=<key>`, Etherscan `?apikey=<key>`, OpenRouter
 * `Authorization: Bearer <key>`). Upstream error bodies and thrown errors can
 * reflect those URLs back, and `forward()` logs them server-side. Scrub every
 * known key shape before anything reaches the logs.
 */

// Keep in sync with ENV_MAP in apiKeys.ts — the resolved values of these keys
// can appear inside provider URLs that upstream errors reflect back.
const PROVIDER_KEY_NAMES: ApiKeyName[] = [
  'alchemyApiKey',
  'coingeckoApiKey',
  'heliusApiKey',
  'moralisApiKey',
  'birdeyeApiKey',
  'novesApiKey',
  'openrouterApiKey',
  'etherscanApiKey'
];

const MAX_LOG_LENGTH = 500;

/** Pattern-based key shapes, independent of what is configured. */
const SECRET_PATTERNS: [RegExp, string][] = [
  // ?api-key=<key> / ?apikey=<key> / ?api_key=<key> (Helius, Etherscan, …)
  [/(api[-_]?key=)[^&\s"']+/gi, '$1[redacted]'],
  // Alchemy key in the URL path: https://<net>.g.alchemy.com/v2/<key>
  [/(g\.alchemy\.com\/v2\/)[A-Za-z0-9_-]+/gi, '$1[redacted]'],
  // Authorization: Bearer <key> (OpenRouter, …)
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]']
];

function stringify(value: unknown): string {
  if (value instanceof Error) {
    let text = `${value.name}: ${value.message}`;
    if (value.cause !== undefined && value.cause !== null) {
      const cause =
        value.cause instanceof Error
          ? `${value.cause.name}: ${value.cause.message}`
          : String(value.cause);
      text += ` (cause: ${cause})`;
    }
    return text;
  }
  return String(value);
}

/**
 * Render an arbitrary value safe for server logs: stringified, truncated to
 * 500 chars, with configured provider keys and common key shapes redacted.
 */
export function redactForLog(value: unknown): string {
  let text = stringify(value);
  if (text.length > MAX_LOG_LENGTH) {
    text = `${text.slice(0, MAX_LOG_LENGTH)}…[truncated]`;
  }
  // Exact-value scrub for each configured provider key (only when set and
  // long enough to be a real key, not a stray short string).
  for (const name of PROVIDER_KEY_NAMES) {
    const key = resolveApiKey(name);
    if (key && key.length >= 8) {
      text = text.replaceAll(key, '[redacted]');
    }
  }
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}
