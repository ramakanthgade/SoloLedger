/** True when the app is built for hosted SaaS (API keys on server, auth required). */
export function isSaasMode(): boolean {
  return import.meta.env.VITE_SAAS_MODE === 'true';
}

/** SoloLedger API base URL (no trailing slash). */
export function getApiBase(): string {
  const configured = String(import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');
  if (configured) return configured;
  // Local SaaS dev: default to local API when env var omitted
  if (isSaasMode() && import.meta.env.DEV) return 'http://localhost:3001';
  return '';
}

export const AUTH_TOKEN_KEY = 'sololedger_auth_token';
