import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { PlanId } from './plans.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');

export type UserRole = 'subscriber' | 'admin';

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  plan: PlanId;
  subscriptionStatus: 'active' | 'trialing' | 'past_due' | 'canceled' | 'none';
  subscriptionExpiresAt: string | null;
  stripeCustomerId?: string;
  createdAt: string;
}

export interface ServerConfig {
  priceApiEnabled: boolean;
  rpcLookupEnabled: boolean;
  aiAdvisorEnabled: boolean;
}

export interface ServerApiKeys {
  alchemyApiKey?: string;
  coingeckoApiKey?: string;
  heliusApiKey?: string;
  moralisApiKey?: string;
  birdeyeApiKey?: string;
  novesApiKey?: string;
  openrouterApiKey?: string;
  etherscanApiKey?: string;
}

interface StoreData {
  users: UserRecord[];
  serverConfig: ServerConfig;
  apiKeys: ServerApiKeys;
}

const DEFAULT_CONFIG: ServerConfig = {
  priceApiEnabled: process.env.PRICE_API_ENABLED !== 'false',
  rpcLookupEnabled: process.env.RPC_LOOKUP_ENABLED !== 'false',
  aiAdvisorEnabled: process.env.AI_ADVISOR_ENABLED !== 'false'
};

function ensureStore(): StoreData {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_FILE)) {
    const initial: StoreData = { users: [], serverConfig: { ...DEFAULT_CONFIG }, apiKeys: {} };
    fs.writeFileSync(STORE_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')) as StoreData;
}

function migrateStore(data: StoreData): StoreData {
  if (!data.apiKeys) data.apiKeys = {};
  return data;
}

let cache: StoreData = migrateStore(ensureStore());

function persist(): void {
  fs.writeFileSync(STORE_FILE, JSON.stringify(cache, null, 2));
}

export function getStore(): StoreData {
  return cache;
}

export function saveStore(next: StoreData): void {
  cache = next;
  persist();
}

export function findUserByEmail(email: string): UserRecord | undefined {
  return cache.users.find((u) => u.email.toLowerCase() === email.toLowerCase());
}

export function findUserById(id: string): UserRecord | undefined {
  return cache.users.find((u) => u.id === id);
}

export function upsertUser(user: UserRecord): void {
  const idx = cache.users.findIndex((u) => u.id === user.id);
  if (idx >= 0) cache.users[idx] = user;
  else cache.users.push(user);
  persist();
}

export function getServerConfig(): ServerConfig {
  return { ...cache.serverConfig };
}

export function updateServerConfig(patch: Partial<ServerConfig>): ServerConfig {
  cache.serverConfig = { ...cache.serverConfig, ...patch };
  persist();
  return { ...cache.serverConfig };
}
