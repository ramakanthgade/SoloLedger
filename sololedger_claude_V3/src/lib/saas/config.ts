/** True when the app is built for hosted SaaS (API keys on server, auth required). */
export function isSaasMode(): boolean {
  return import.meta.env.VITE_SAAS_MODE === 'true';
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
