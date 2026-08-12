import { describe, expect, it } from 'vitest';
import {
  isBigoneInvalidJwtResponse,
  isBitgetInvalidAccessKeyResponse,
  isBitgetPublicTimeResponse,
  isDigifinexInvalidKeyResponse,
  isExmoInvalidKeyResponse,
  isHollaexInvalidKeyResponse,
  isTokocryptoInvalidKeyResponse
} from '../scripts/live-verify-exchange-tunnel.mjs';

describe('live exchange-tunnel verifier Bitget predicates', () => {
  it('requires a decimal string serverTime for tier 2', () => {
    const response = { status: 200 };
    expect(isBitgetPublicTimeResponse(response, {
      code: '00000', data: { serverTime: '1786233600000' }
    })).toBe(true);
    expect(isBitgetPublicTimeResponse(response, {
      code: '00000', data: { serverTime: 1786233600000 }
    })).toBe(false);
    expect(isBitgetPublicTimeResponse(response, {
      code: '00000', data: { serverTime: '1786233600000.5' }
    })).toBe(false);
  });

  it.each([
    ['40006', 'Invalid ACCESS_KEY'],
    ['40037', 'Apikey does not exist']
  ])('accepts exact HTTP 400 for the tier-3 %s response', (code, msg) => {
    expect(isBitgetInvalidAccessKeyResponse({
      status: 400, text: JSON.stringify({ code, msg })
    })).toBe(true);
  });

  it.each([
    [401, '40006', 'Invalid ACCESS_KEY'],
    [401, '40037', 'Apikey does not exist'],
    [400, '40012', 'Invalid ACCESS_KEY'],
    [400, '40006', 'Apikey does not exist'],
    [400, '40037', 'Invalid ACCESS_KEY'],
    [400, '40037', 'Apikey does not exist.'],
    [400, '40037', 'apikey does not exist']
  ])('rejects status %s with code %s and message %s', (status, code, msg) => {
    expect(isBitgetInvalidAccessKeyResponse({
      status, text: JSON.stringify({ code, msg })
    })).toBe(false);
  });
});

describe('live exchange-tunnel verifier batch-two tier-3 predicates', () => {
  it.each([
    [isDigifinexInvalidKeyResponse, 200, { code: 10002 }],
    [isBigoneInvalidJwtResponse, 401, { code: 40004, message: 'invalid jwt' }],
    [isTokocryptoInvalidKeyResponse, 401, { code: -2014, msg: 'API-key format invalid.' }],
    [isHollaexInvalidKeyResponse, 401, { message: 'Access denied: Access Denied: Invalid API Key' }],
    [isExmoInvalidKeyResponse, 200, { result: false, error: 'Error 40017: Wrong api key' }]
  ])('accepts the distinctive live dummy-key response %#', (predicate, status, body) => {
    expect(predicate({ status, text: JSON.stringify(body) })).toBe(true);
  });

  it.each([
    [isDigifinexInvalidKeyResponse, 401, { code: 10002 }],
    [isBigoneInvalidJwtResponse, 401, { code: 40004, message: 'unauthorized' }],
    [isTokocryptoInvalidKeyResponse, 451, { code: -2014, msg: 'API-key format invalid.' }],
    [isHollaexInvalidKeyResponse, 401, { message: 'Invalid API Key' }],
    [isExmoInvalidKeyResponse, 400, { result: false, error: 'Error 40017: Wrong api key' }]
  ])('rejects broad lookalike response %#', (predicate, status, body) => {
    expect(predicate({ status, text: JSON.stringify(body) })).toBe(false);
  });
});
