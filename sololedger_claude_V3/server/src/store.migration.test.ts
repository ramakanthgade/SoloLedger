import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeLegacyPlans, STORE_SCHEMA_VERSION, type UserRecord } from './store.js';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

type LegacyStore = {
  users: (UserRecord & { customTxLimit?: number | null })[];
  serverConfig: { priceApiEnabled: boolean; rpcLookupEnabled: boolean; aiAdvisorEnabled: boolean };
  apiKeys: Record<string, unknown>;
  schemaVersion?: number;
};

function legacyStore(): LegacyStore {
  return {
    users: [
      {
        id: '1',
        email: 'free@b.co',
        passwordHash: 'x',
        role: 'subscriber',
        plan: 'starter' as UserRecord['plan'],
        subscriptionStatus: 'none',
        subscriptionExpiresAt: null,
        createdAt: new Date().toISOString()
      },
      {
        id: '2',
        email: 'trial@b.co',
        passwordHash: 'x',
        role: 'subscriber',
        plan: 'trial' as UserRecord['plan'],
        subscriptionStatus: 'trialing',
        subscriptionExpiresAt: null,
        createdAt: new Date().toISOString()
      },
      {
        id: '3',
        email: 'paid@b.co',
        passwordHash: 'x',
        role: 'subscriber',
        plan: 'pro',
        subscriptionStatus: 'active',
        subscriptionExpiresAt: null,
        customTxLimit: 25_000,
        createdAt: new Date().toISOString()
      }
    ],
    serverConfig: { priceApiEnabled: true, rpcLookupEnabled: true, aiAdvisorEnabled: true },
    apiKeys: {}
  };
}

describe('normalizeLegacyPlans (D6 migration)', () => {
  it('migrates old free "starter" and "trial" users to "local"', () => {
    const migrated = normalizeLegacyPlans(legacyStore() as never);
    expect(migrated.users[0].plan).toBe('local');
    expect(migrated.users[1].plan).toBe('local');
  });

  it('leaves paid plans (pro) intact and renames customTxLimit → customIncludedUnits', () => {
    const migrated = normalizeLegacyPlans(legacyStore() as never);
    const pro = migrated.users[2] as UserRecord & { customTxLimit?: number };
    expect(pro.plan).toBe('pro');
    expect(pro.customIncludedUnits).toBe(25_000);
    expect(pro.customTxLimit).toBeUndefined();
  });

  it('stamps the current schema version and is idempotent', () => {
    const once = normalizeLegacyPlans(legacyStore() as never);
    expect(once.schemaVersion).toBe(STORE_SCHEMA_VERSION);
    const twice = normalizeLegacyPlans(once);
    expect(twice.users[0].plan).toBe('local');
  });
});

describe('store load applies and persists the migration', () => {
  it('rewrites a legacy plaintext store with migrated plans on first load', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-store-mig-'));
    const storeFile = path.join(dir, 'store.json');
    fs.writeFileSync(storeFile, JSON.stringify(legacyStore(), null, 2));

    process.env.NODE_ENV = 'development';
    delete process.env.DATA_ENCRYPTION_KEY;
    process.env.DATA_DIR = dir;

    vi.resetModules();
    const store = await import('./store.js');

    const users = store.getStore().users;
    expect(users.find((u) => u.email === 'free@b.co')?.plan).toBe('local');
    expect(users.find((u) => u.email === 'trial@b.co')?.plan).toBe('local');
    expect(users.find((u) => u.email === 'paid@b.co')?.plan).toBe('pro');

    // Migration was persisted (schemaVersion stamped on disk).
    const onDisk = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    expect(onDisk.schemaVersion).toBe(store.STORE_SCHEMA_VERSION);
    expect(onDisk.users.find((u: UserRecord) => u.email === 'free@b.co').plan).toBe('local');

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
