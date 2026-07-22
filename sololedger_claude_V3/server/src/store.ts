import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { migrateLegacyPlan, type PlanId } from './plans.js';

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
  /** Admin override — if set, replaces the plan's default included-unit allowance. */
  customIncludedUnits?: number | null;
  /** Enterprise only — prepaid 1,000-event packs bought above the 10,000 base. */
  overageBlocks?: number | null;
  createdAt: string;
}

export interface ServerConfig {
  priceApiEnabled: boolean;
  rpcLookupEnabled: boolean;
  aiAdvisorEnabled: boolean;
  exchangeSyncEnabled: boolean;
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
  /** Bumped when the stored user/plan shape changes; drives one-time migrations. */
  schemaVersion?: number;
}

/** Current store schema version — see migrateStore(). */
export const STORE_SCHEMA_VERSION = 1;

const DEFAULT_CONFIG: ServerConfig = {
  priceApiEnabled: process.env.PRICE_API_ENABLED !== 'false',
  rpcLookupEnabled: process.env.RPC_LOOKUP_ENABLED !== 'false',
  aiAdvisorEnabled: process.env.AI_ADVISOR_ENABLED !== 'false',
  exchangeSyncEnabled: process.env.EXCHANGE_SYNC_ENABLED !== 'false'
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

/** Decode a 32-byte key from a hex (64 chars) or base64 string. */
export function decodeKey(raw: string): Buffer {
  const trimmed = raw.trim();
  // Try hex first (64 chars), then base64.
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }
  return Buffer.from(trimmed, 'base64');
}

/**
 * Resolve the AES-256 key from DATA_ENCRYPTION_KEY.
 * Returns null when no key is configured in a non-production environment
 * (plaintext fallback). Throws on missing key in production or on any
 * present-but-invalid key. Reads process.env live so it is testable in isolation.
 */
export function resolveEncryptionKey(): Buffer | null {
  const raw = process.env.DATA_ENCRYPTION_KEY?.trim();
  const isProduction = process.env.NODE_ENV === 'production';

  if (!raw) {
    if (isProduction) {
      throw new Error(
        'DATA_ENCRYPTION_KEY is required in production. Provide a 32-byte key ' +
          '(base64 or hex) to encrypt the data store at rest.'
      );
    }
    console.warn(
      '[store] DATA_ENCRYPTION_KEY is not set — data store will be written in ' +
        'PLAINTEXT. Set a 32-byte key (base64 or hex) before deploying to production.'
    );
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

const ENCRYPTION_KEY = resolveEncryptionKey();

export function encryptData(plaintext: string, key: Buffer | null = ENCRYPTION_KEY): string {
  if (!key) return plaintext;
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX + Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function decryptData(contents: string, key: Buffer | null = ENCRYPTION_KEY): string {
  if (!key) {
    throw new Error(
      'Data store is encrypted but DATA_ENCRYPTION_KEY is not set (or invalid). ' +
        'Provide the key that was used to encrypt it.'
    );
  }
  const payload = Buffer.from(contents.slice(ENC_PREFIX.length), 'base64');
  const iv = payload.subarray(0, IV_BYTES);
  const tag = payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const encrypted = payload.subarray(IV_BYTES + TAG_BYTES);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

/** Atomically write the store file (encrypted if a key is configured) via temp-file + rename. */
function writeStoreFile(plaintextJson: string): void {
  const tmp = `${STORE_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, encryptData(plaintextJson));
  fs.renameSync(tmp, STORE_FILE);
}

function readStoreFile(): StoreData {
  const contents = fs.readFileSync(STORE_FILE, 'utf8');
  if (contents.startsWith(ENC_PREFIX)) {
    return JSON.parse(decryptData(contents)) as StoreData;
  }
  // Legacy plaintext store. Load it, and if a key is configured, immediately
  // re-write it encrypted so secrets (API keys, password hashes, Stripe IDs)
  // do not linger in plaintext until the next incidental save.
  const data = JSON.parse(contents) as StoreData;
  if (ENCRYPTION_KEY) {
    writeStoreFile(JSON.stringify(data, null, 2));
  }
  return data;
}

function ensureStore(): StoreData {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_FILE)) {
    const initial: StoreData = {
      users: [],
      serverConfig: { ...DEFAULT_CONFIG },
      apiKeys: {},
      schemaVersion: STORE_SCHEMA_VERSION
    };
    writeStoreFile(JSON.stringify(initial, null, 2));
    return initial;
  }
  return readStoreFile();
}

function migrateStore(data: StoreData): StoreData {
  if (!data.apiKeys) data.apiKeys = {};
  // Backfill serverConfig keys missing from stores written before those flags
  // existed (e.g. exchangeSyncEnabled on the production store.json) — without
  // this they read as undefined → falsy → silently OFF.
  data.serverConfig = { ...DEFAULT_CONFIG, ...data.serverConfig };
  return normalizeLegacyPlans(data);
}

/**
 * One-time legacy normalization (D6). The old model had a FREE "Starter"
 * (100-tx) tier and a "trial" tier; both now map to the new free `local`
 * tier. The old `customTxLimit` field is renamed to `customIncludedUnits`.
 * Idempotent and guarded by STORE_SCHEMA_VERSION so it only rewrites once.
 */
export function normalizeLegacyPlans(data: StoreData): StoreData {
  if (data.schemaVersion === STORE_SCHEMA_VERSION) return data;

  for (const user of data.users) {
    // Migrate old plan ids (`starter`/`trial` FREE tier → new free `local`).
    user.plan = migrateLegacyPlan(user.plan as string);

    // Rename the legacy admin override field.
    const legacy = user as UserRecord & { customTxLimit?: number | null };
    if (legacy.customTxLimit != null && user.customIncludedUnits == null) {
      user.customIncludedUnits = legacy.customTxLimit;
    }
    delete legacy.customTxLimit;
  }

  data.schemaVersion = STORE_SCHEMA_VERSION;
  return data;
}

const rawStore = ensureStore();
const needsMigration = rawStore.schemaVersion !== STORE_SCHEMA_VERSION;
let cache: StoreData = migrateStore(rawStore);
// Persist the one-time legacy normalization so it does not re-run each load.
if (needsMigration) {
  writeStoreFile(JSON.stringify(cache, null, 2));
}

function persist(): void {
  writeStoreFile(JSON.stringify(cache, null, 2));
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
