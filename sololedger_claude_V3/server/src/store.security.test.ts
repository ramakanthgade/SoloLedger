import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeKey, encryptData, decryptData, resolveEncryptionKey } from './store.js';

const ORIGINAL_ENV = { ...process.env };
const KEY_BYTES = crypto.randomBytes(32);
const KEY_B64 = KEY_BYTES.toString('base64');
const KEY_HEX = KEY_BYTES.toString('hex');

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe('decodeKey', () => {
  it('decodes a 64-char hex key to 32 bytes', () => {
    expect(decodeKey(KEY_HEX)).toHaveLength(32);
    expect(decodeKey(KEY_HEX).equals(KEY_BYTES)).toBe(true);
  });

  it('decodes a base64 key to 32 bytes', () => {
    expect(decodeKey(KEY_B64)).toHaveLength(32);
    expect(decodeKey(KEY_B64).equals(KEY_BYTES)).toBe(true);
  });
});

describe('encryptData / decryptData round-trip', () => {
  const plaintext = JSON.stringify({ users: [{ email: 'a@b.co', passwordHash: 'x' }] });

  it('encrypts with SLENC1: prefix and decrypts back (base64 key)', () => {
    const key = decodeKey(KEY_B64);
    const enc = encryptData(plaintext, key);
    expect(enc.startsWith('SLENC1:')).toBe(true);
    expect(enc).not.toContain('a@b.co');
    expect(decryptData(enc, key)).toBe(plaintext);
  });

  it('encrypts and decrypts back (hex key)', () => {
    const key = decodeKey(KEY_HEX);
    const enc = encryptData(plaintext, key);
    expect(enc.startsWith('SLENC1:')).toBe(true);
    expect(decryptData(enc, key)).toBe(plaintext);
  });

  it('returns plaintext unchanged when no key is provided', () => {
    expect(encryptData(plaintext, null)).toBe(plaintext);
  });

  it('throws when decrypting with a different key (auth tag mismatch)', () => {
    const enc = encryptData(plaintext, decodeKey(KEY_B64));
    expect(() => decryptData(enc, crypto.randomBytes(32))).toThrow();
  });
});

describe('resolveEncryptionKey', () => {
  it('throws in production when DATA_ENCRYPTION_KEY is missing', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.DATA_ENCRYPTION_KEY;
    expect(() => resolveEncryptionKey()).toThrow(/required in production/);
  });

  it('throws when the key decodes to the wrong length', () => {
    process.env.NODE_ENV = 'production';
    process.env.DATA_ENCRYPTION_KEY = 'too-short';
    expect(() => resolveEncryptionKey()).toThrow(/must decode to 32 bytes/);
  });

  it('returns a 32-byte buffer for a valid base64 key', () => {
    process.env.NODE_ENV = 'production';
    process.env.DATA_ENCRYPTION_KEY = KEY_B64;
    expect(resolveEncryptionKey()).toHaveLength(32);
  });

  it('returns a 32-byte buffer for a valid hex key', () => {
    process.env.NODE_ENV = 'production';
    process.env.DATA_ENCRYPTION_KEY = KEY_HEX;
    expect(resolveEncryptionKey()).toHaveLength(32);
  });

  it('falls back to null (plaintext) with a warning outside production', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.DATA_ENCRYPTION_KEY;
    expect(resolveEncryptionKey()).toBeNull();
    expect(console.warn).toHaveBeenCalledOnce();
  });
});

describe('legacy plaintext store is re-encrypted on startup', () => {
  it('re-writes an existing plaintext store.json encrypted when a key is configured', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-store-'));
    const storeFile = path.join(dir, 'store.json');
    const legacy = {
      users: [{ id: '1', email: 'a@b.co', passwordHash: 'bcrypt$hash', role: 'admin' }],
      serverConfig: { priceApiEnabled: true, rpcLookupEnabled: true, aiAdvisorEnabled: true },
      apiKeys: { alchemyApiKey: 'secret-key' }
    };
    fs.writeFileSync(storeFile, JSON.stringify(legacy, null, 2));
    // Sanity: starts as readable plaintext containing secrets.
    expect(fs.readFileSync(storeFile, 'utf8')).toContain('secret-key');

    process.env.NODE_ENV = 'production';
    process.env.DATA_ENCRYPTION_KEY = KEY_B64;
    process.env.DATA_DIR = dir;

    // Fresh module load triggers ensureStore() -> readStoreFile() migration.
    vi.resetModules();
    const store = await import('./store.js');

    const onDisk = fs.readFileSync(storeFile, 'utf8');
    expect(onDisk.startsWith('SLENC1:')).toBe(true);
    expect(onDisk).not.toContain('secret-key');
    // Data survives the migration and is readable via the store API.
    expect(store.getStore().apiKeys.alchemyApiKey).toBe('secret-key');

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
