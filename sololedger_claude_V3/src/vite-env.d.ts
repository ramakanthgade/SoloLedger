/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * SoloLedger license-signing PUBLIC key (Ed25519, 32 bytes, base64url),
   * injected at build time by ops. When unset the verifier falls back to the
   * all-zero placeholder and reports "licensing not configured". See
   * `src/lib/billing/license.ts`.
   */
  readonly VITE_SOLOLEDGER_LICENSE_PUBKEY?: string;
}
