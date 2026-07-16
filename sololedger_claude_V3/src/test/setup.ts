import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { createHash } from 'node:crypto';
import * as ed from '@noble/ed25519';

// @noble/ed25519 v2 hashes via WebCrypto's `crypto.subtle.digest` by default.
// Under jsdom that implementation is broken ("2nd argument is not instance of
// ArrayBuffer…"), so any code exercising the ed25519 license verifier throws.
// Wire the SHA-512 hook to Node's crypto so signing/verifying works in tests
// exactly as it does in a real browser (which has a working SubtleCrypto).
const sha512 = (...msgs: Uint8Array[]) =>
  new Uint8Array(createHash('sha512').update(ed.etc.concatBytes(...msgs)).digest());
ed.etc.sha512Sync = sha512;
ed.etc.sha512Async = async (...msgs: Uint8Array[]) => sha512(...msgs);

// Unmount React trees after each test to avoid cross-test DOM leakage.
afterEach(() => {
  cleanup();
});
