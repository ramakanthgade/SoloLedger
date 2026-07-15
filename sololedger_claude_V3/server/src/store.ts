import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import type { PlanId } from './plans.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Override with Railway Volume mount path, e.g. DATA_DIR=/data */
const DATA_DIR = process.env.DATA_DIR?.trim()
  ? path.resolve(process.env.DATA_DIR.trim())
  : path.join(__dirname, '..', 'data');
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
  /** Admin override — if set, replaces plan default tx limit */
  customTxLimit?: number | null;
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

/* ------------------------------------------------------------------ *
 * At-rest encryption (AES-256-GCM) for the JSON store.
 *
 * store.json holds sensitive data (bcrypt hashes, Stripe customer IDs,
 * provider API keys). We encrypt it with a 32-byte key from
 * DATA_ENCRYPTION_KEY (base64 or hex).
 *   - Production: key required; missing/invalid => fail-fast (throw).
 *   - Dev: key optional; if absent, fall back to plaintext with a
 *     one-time warning so local dev still works.
 * Existing plaintext store.json is transparently loaded (migration) and
 * re-written encrypted on the next save when a key is available.
 * ------------------------------------------------------------------ */
const ENC_PREFIX = 'SLENC1:';
const IV_BYTES = 12;
const TAG_BYTES = 16;

function decodeKey(raw: string): Buffer {
  const trimmed = raw.trim();
  // Try hex first (64 chars), then base64.
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }
  const buf = Buffer.from(trimmed, 'base64');
  return buf;
}

/**
 * Resolve the AES-256 key from DATA_ENCRYPTION_KEY.
 * Returns null when no key is configured in a non-production environment
 * (plaintext fallback). Throws on missing key in production or on any
 * present-but-invalid key.
 */
function resolveEncryptionKey(): Buffer | null {
  const raw = process.env.DATA_ENCRYPTION_KEY?.trim();
  const isProduction = process.env.NODE_ENV === 'production';

  if (!raw) {
    if (isProduction) {
      throw new Error(
        'DATA_ENCRYPTION_KEY is required in production. Provide a 32-byte key ' +
          '(base64 or hex) to encrypt the data store at rest.'
      );
    }
    if (!plaintextWarningShown) {
      console.warn(
        '[store] DATA_ENCRYPTION_KEY is not set — data store will be written in ' +
          'PLAINTEXT. Set a 32-byte key (base64 or hex) before deploying to production.'
      );
      plaintextWarningShown = true;
    }
    return null;
  }

  const key = decodeKey(raw);
  if (key.length !== 32) {
    throw new Error(
      `DATA_ENCRYPTION_KEY must decode to 32 bytes (got ${key.length}). ` +
        'Provide a 32-byte key encoded as base64 or hex.'
    );
  }
  return key;
}

let plaintextWarningShown = false;
const ENCRYPTION_KEY = resolveEncryptionKey();

function encryptData(plaintext: string): string {
  if (!ENCRYPTION_KEY) return plaintext;
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX + Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decryptData(contents: string): string {
  if (!ENCRYPTION_KEY) {
    throw new Error(
      'Data store is encrypted but DATA_ENCRYPTION_KEY is not set (or invalid). ' +
        'Provide the key that was used to encrypt it.'
    );
  }
  const payload = Buffer.from(contents.slice(ENC_PREFIX.length), 'base64');
  const iv = payload.subarray(0, IV_BYTES);
  const tag = payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const encrypted = payload.subarray(IV_BYTES + TAG_BYTES);
  const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

function readStoreFile(): StoreData {
  const contents = fs.readFileSync(STORE_FILE, 'utf8');
  if (contents.startsWith(ENC_PREFIX)) {
    return JSON.parse(decryptData(contents)) as StoreData;
  }
  // Plaintext (legacy / dev). Loaded as-is; re-written encrypted on next save.
  return JSON.parse(contents) as StoreData;
}

function ensureStore(): StoreData {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_FILE)) {
    const initial: StoreData = { users: [], serverConfig: { ...DEFAULT_CONFIG }, apiKeys: {} };
    fs.writeFileSync(STORE_FILE, encryptData(JSON.stringify(initial, null, 2)));
    return initial;
  }
  return readStoreFile();
}

function migrateStore(data: StoreData): StoreData {
  if (!data.apiKeys) data.apiKeys = {};
  return data;
}

let cache: StoreData = migrateStore(ensureStore());

function persist(): void {
  fs.writeFileSync(STORE_FILE, encryptData(JSON.stringify(cache, null, 2)));
}

export function getStore(): StoreData {
  return cache;
}

/** Resolved data directory (for ops / logging). */
export function getDataDirectory(): string {
  return DATA_DIR;
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
