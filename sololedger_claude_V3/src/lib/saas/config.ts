import { getMode } from './mode';

/**
 * True when the app is running in hosted SaaS mode (API keys on the server,
 * auth required, requests routed through the Railway proxy).
 *
 * Back-compat shim: mode is now RUNTIME state (see ./mode). Only 'hosted' is a
 * SaaS environment — 'local' and 'byok' both map to non-hosted and share the
 * exact same transport branch, so the ~13 existing `isSaasMode()` call sites
 * keep working unchanged.
 */
export function isSaasMode(): boolean {
  return getMode() === 'hosted';
}

/** SoloLedger API base URL (no trailing slash). */
export function getApiBase(): string {
  const configured = String(import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');
  if (configured) return configured;
  if (isSaasMode()) {
    // Default to the hosted API so local `npm run dev` can import/repair wallets
    // without also running Express on :3001. Override with VITE_API_URL if needed.
    return 'https://sololedger-production.up.railway.app';
  }
  return '';
}

export const AUTH_TOKEN_KEY = 'sololedger_auth_token';
