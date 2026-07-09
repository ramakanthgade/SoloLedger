import { AUTH_TOKEN_KEY, getApiBase, isSaasMode } from './config';

export interface PublicUser {
  id: string;
  email: string;
  role: 'subscriber' | 'admin';
  plan: 'starter' | 'standard' | 'pro' | 'trial';
  subscriptionStatus: string;
  subscriptionExpiresAt: string | null;
  txLimit: number;
  subscriptionActive: boolean;
}

export interface PublicServerConfig {
  priceApiEnabled: boolean;
  rpcLookupEnabled: boolean;
  aiAdvisorEnabled: boolean;
}

export function getAuthToken(): string | null {
  if (!isSaasMode()) return null;
  return localStorage.getItem(AUTH_TOKEN_KEY);
}

export function setAuthToken(token: string | null): void {
  if (token) localStorage.setItem(AUTH_TOKEN_KEY, token);
  else localStorage.removeItem(AUTH_TOKEN_KEY);
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type') && init.body && typeof init.body === 'string') {
    headers.set('Content-Type', 'application/json');
  }
  const token = getAuthToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(`${getApiBase()}${path}`, { ...init, headers });
}

export async function fetchPublicConfig(): Promise<PublicServerConfig> {
  const res = await apiFetch('/api/config/public');
  if (!res.ok) throw new Error('Failed to load server config');
  return res.json();
}

export async function login(email: string, password: string): Promise<{ token: string; user: PublicUser }> {
  const res = await apiFetch('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? 'Login failed');
  return data;
}

export async function register(email: string, password: string): Promise<{ token: string; user: PublicUser }> {
  const res = await apiFetch('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? 'Registration failed');
  return data;
}

export async function fetchMe(): Promise<PublicUser> {
  const res = await apiFetch('/api/auth/me');
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? 'Session expired');
  return data.user;
}

export async function startCheckout(plan: string): Promise<string | null> {
  const res = await apiFetch('/api/billing/checkout', {
    method: 'POST',
    body: JSON.stringify({ plan })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? 'Checkout failed');
  return data.url ?? null;
}

export async function saasProxyFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return apiFetch(path, init);
}
