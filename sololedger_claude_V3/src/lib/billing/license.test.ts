import { describe, expect, it, beforeAll } from 'vitest';
import * as ed from '@noble/ed25519';
import {
  base64urlEncode,
  encodeLicenseKey,
  licensePayloadBytes,
  verifyLicenseKey,
  type LicensePayload
} from './license';

// A real test keypair generated once for the suite. The verifier is exercised
// against this key (via the publicKeyB64url override) — the production embedded
// key intentionally rejects everything until the real key is dropped in.
let privateKey: Uint8Array;
let publicKeyB64url: string;

const PAYLOAD: LicensePayload = {
  tier: 'standard',
  taxYear: 2025,
  issuedAt: Date.UTC(2025, 5, 1),
  licenseId: 'lic_test_0001',
  includedUnits: 2_000
};

async function signPayload(payload: LicensePayload, key: Uint8Array): Promise<string> {
  const sig = await ed.signAsync(licensePayloadBytes(payload), key);
  return encodeLicenseKey(payload, sig);
}

beforeAll(async () => {
  privateKey = ed.utils.randomPrivateKey();
  const pub = await ed.getPublicKeyAsync(privateKey);
  publicKeyB64url = base64urlEncode(pub);
});

describe('verifyLicenseKey', () => {
  it('unlocks the encoded tier + includedUnits for a validly signed key', async () => {
    const key = await signPayload(PAYLOAD, privateKey);
    const r = await verifyLicenseKey(key, publicKeyB64url);
    expect(r.valid).toBe(true);
    expect(r.tier).toBe('standard');
    expect(r.taxYear).toBe(2025);
    expect(r.includedUnits).toBe(2_000);
    expect(r.licenseId).toBe('lic_test_0001');
  });

  it('uses the SIGNED includedUnits as the authoritative allowance (not the catalog)', async () => {
    // An Enterprise license with a prepaid pack: signed 13,000 overrides the
    // 10,000 catalog base.
    const enterprise: LicensePayload = {
      ...PAYLOAD,
      tier: 'enterprise',
      includedUnits: 13_000,
      licenseId: 'lic_ent_pack'
    };
    const key = await signPayload(enterprise, privateKey);
    const r = await verifyLicenseKey(key, publicKeyB64url);
    expect(r.valid).toBe(true);
    expect(r.includedUnits).toBe(13_000);
  });

  it('rejects a tampered payload (signature no longer matches)', async () => {
    const key = await signPayload(PAYLOAD, privateKey);
    const [payloadPart, sigPart] = key.split('.');
    // Flip the includedUnits by re-encoding a different payload with the old sig.
    const tampered: LicensePayload = { ...PAYLOAD, includedUnits: 999_999 };
    const tamperedPayloadB64 = base64urlEncode(licensePayloadBytes(tampered));
    expect(tamperedPayloadB64).not.toBe(payloadPart);
    const forged = `${tamperedPayloadB64}.${sigPart}`;
    const r = await verifyLicenseKey(forged, publicKeyB64url);
    expect(r.valid).toBe(false);
  });

  it('rejects a signature from the wrong key', async () => {
    const otherPriv = ed.utils.randomPrivateKey();
    const key = await signPayload(PAYLOAD, otherPriv);
    const r = await verifyLicenseKey(key, publicKeyB64url);
    expect(r.valid).toBe(false);
  });

  it('rejects malformed keys', async () => {
    expect((await verifyLicenseKey('', publicKeyB64url)).valid).toBe(false);
    expect((await verifyLicenseKey('no-dot-here', publicKeyB64url)).valid).toBe(false);
    expect((await verifyLicenseKey('.', publicKeyB64url)).valid).toBe(false);
  });

  it('rejects everything against the default (placeholder) embedded key', async () => {
    const key = await signPayload(PAYLOAD, privateKey);
    // No override → uses the all-zero placeholder public key.
    const r = await verifyLicenseKey(key);
    expect(r.valid).toBe(false);
  });
});
