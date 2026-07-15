import { afterEach, describe, expect, it } from 'vitest';
import { isDevActivateBlocked } from './billing.js';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('activate-dev production guard', () => {
  it('is blocked (403 path) when NODE_ENV=production', () => {
    process.env.NODE_ENV = 'production';
    expect(isDevActivateBlocked()).toBe(true);
  });

  it('is allowed in development', () => {
    process.env.NODE_ENV = 'development';
    expect(isDevActivateBlocked()).toBe(false);
  });

  it('is allowed in test', () => {
    process.env.NODE_ENV = 'test';
    expect(isDevActivateBlocked()).toBe(false);
  });

  it('ignores the removed ALLOW_DEV_ACTIVATE escape hatch in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.ALLOW_DEV_ACTIVATE = 'true';
    expect(isDevActivateBlocked()).toBe(true);
  });
});
