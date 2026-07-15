import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEV_JWT_SECRET, resolveJwtSecret } from './auth.js';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe('resolveJwtSecret', () => {
  it('throws in production when JWT_SECRET is unset', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.JWT_SECRET;
    expect(() => resolveJwtSecret()).toThrow(/JWT_SECRET must be set/);
  });

  it('throws in production when JWT_SECRET is empty', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = '   ';
    expect(() => resolveJwtSecret()).toThrow(/JWT_SECRET must be set/);
  });

  it('throws in production when JWT_SECRET equals the dev default', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = DEV_JWT_SECRET;
    expect(() => resolveJwtSecret()).toThrow(/JWT_SECRET must be set/);
  });

  it('accepts a strong secret in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'a-sufficiently-strong-production-secret';
    expect(resolveJwtSecret()).toBe('a-sufficiently-strong-production-secret');
  });

  it('falls back to the dev default (with a warning) outside production', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.JWT_SECRET;
    expect(resolveJwtSecret()).toBe(DEV_JWT_SECRET);
    expect(console.warn).toHaveBeenCalledOnce();
  });
});
