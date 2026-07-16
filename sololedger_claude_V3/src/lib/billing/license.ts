/**
 * On-device signed license verifier (D6).
 *
 * SoloLedger paid tiers are unlocked by an Ed25519-signed license key that the
 * user pastes into Settings. There is NO account and NO network call: the key
 * is a bearer credential verified entirely on-device against a SoloLedger
 * public key embedded at build time.
 *
 * The matching PRIVATE key is held offline by the issuer (a backend/ops
 * concern) and is NEVER present in client code. Issuing keys is out of scope
 * here — this module only defines the verifier and the public-key constant.
 *
 * License key format (all base64url, signature appended):
 *     <base64url(payloadJson)>.<base64url(ed25519Signature)>
 * where the signature is over the raw payload bytes.
 *
 * Payload: { tier, taxYear, issuedAt, licenseId, includedUnits }.
 * The signed `includedUnits` is authoritative for the allowance cap of ALL
 * paid tiers (the client does NOT re-derive it from the catalog). There is no
 * expiry beyond `taxYear` scoping.
 */

import { verifyAsync } from '@noble/ed25519';
import type { PlanId } from '@/lib/saas/plans';

/**
 * SoloLedger license-signing PUBLIC key (Ed25519, 32 bytes, base64url).
 *
 * This is a build-time constant. The corresponding private key is kept offline
 * by the issuer and is used to stamp customer licenses out-of-band. Replace
 * this placeholder with the real production public key before shipping paid
 * licenses; the verifier below rejects anything not signed by this key.
 *
 * NOTE: the value below is a documented PLACEHOLDER (all-zero key) so the
 * verifier is wired end-to-end; every real license will fail against it until
 * the production key is dropped in, which is the safe default.
 */
export const SOLOLEDGER_LICENSE_PUBLIC_KEY_B64URL = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

export interface LicensePayload {
  tier: PlanId;
  taxYear: number;
  issuedAt: number;
  licenseId: string;
  includedUnits: number;
}

export interface LicenseVerificationResult {
  valid: boolean;
  tier?: PlanId;
  taxYear?: number;
  includedUnits?: number;
  licenseId?: string;
}

const PAID_TIERS: PlanId[] = ['starter', 'standard', 'pro', 'investor', 'enterprise'];

/* ------------------------------------------------------------------ *
 * base64url helpers (no padding), safe in browser + Node.
 * ------------------------------------------------------------------ */

export function base64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  const b64 = typeof btoa === 'function' ? btoa(binary) : Buffer.from(bytes).toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlDecode(input: string): Uint8Array {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  const binary =
    typeof atob === 'function'
      ? atob(b64 + pad)
      : Buffer.from(b64 + pad, 'base64').toString('binary');
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Build a license-key string from a payload and its Ed25519 signature.
 * Exposed mainly for tests / the (offline) issuer tooling.
 */
export function encodeLicenseKey(payload: LicensePayload, signature: Uint8Array): string {
  const payloadBytes = textEncoder.encode(JSON.stringify(payload));
  return `${base64urlEncode(payloadBytes)}.${base64urlEncode(signature)}`;
}

/** The raw payload bytes that must be signed for a given payload. */
export function licensePayloadBytes(payload: LicensePayload): Uint8Array {
  return textEncoder.encode(JSON.stringify(payload));
}

function isValidPayloadShape(p: unknown): p is LicensePayload {
  if (!p || typeof p !== 'object') return false;
  const o = p as Record<string, unknown>;
  return (
    typeof o.tier === 'string' &&
    PAID_TIERS.includes(o.tier as PlanId) &&
    typeof o.taxYear === 'number' &&
    typeof o.issuedAt === 'number' &&
    typeof o.licenseId === 'string' &&
    typeof o.includedUnits === 'number' &&
    o.includedUnits > 0
  );
}

/**
 * Verify a pasted license key against the embedded SoloLedger public key.
 * Returns the signed tier + taxYear + includedUnits when valid; any decode
 * failure, tampered payload, or wrong-key signature yields `{ valid: false }`.
 *
 * @param publicKeyB64url override the embedded key (used by tests with a real
 *   generated keypair). Defaults to {@link SOLOLEDGER_LICENSE_PUBLIC_KEY_B64URL}.
 */
export async function verifyLicenseKey(
  key: string,
  publicKeyB64url: string = SOLOLEDGER_LICENSE_PUBLIC_KEY_B64URL
): Promise<LicenseVerificationResult> {
  try {
    const trimmed = key.trim();
    const dot = trimmed.indexOf('.');
    if (dot <= 0 || dot === trimmed.length - 1) return { valid: false };

    const payloadBytes = base64urlDecode(trimmed.slice(0, dot));
    const signature = base64urlDecode(trimmed.slice(dot + 1));
    const publicKey = base64urlDecode(publicKeyB64url);

    const ok = await verifyAsync(signature, payloadBytes, publicKey);
    if (!ok) return { valid: false };

    const payload = JSON.parse(textDecoder.decode(payloadBytes)) as unknown;
    if (!isValidPayloadShape(payload)) return { valid: false };

    return {
      valid: true,
      tier: payload.tier,
      taxYear: payload.taxYear,
      includedUnits: payload.includedUnits,
      licenseId: payload.licenseId
    };
  } catch {
    return { valid: false };
  }
}
