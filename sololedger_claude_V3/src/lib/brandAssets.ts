/**
 * Base path for bundled brand icons, honoring the Vite `base` config.
 *
 * GitHub Pages serves the app under `/SoloLedger/` (deploy sets
 * VITE_BASE_PATH=/SoloLedger/), so a hard-coded `/assets/...` <img> src 404s
 * there — and the onError letter-chip fallback hid that breakage on the live
 * site for a full release (user-reported 26 Jul 2026: "ME"/"TR"/"B"/"U"
 * chips everywhere instead of logos). Local dev serves at root, which is why
 * it never reproduced in testing. Always build icon URLs through this module.
 */
const BASE = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');

export const BRAND_ICON_BASE = `${BASE}/assets/brand-icons`;

/** URL for a bundled file under public/assets/brand-icons/. */
export function brandIconUrl(file: string): string {
  return `${BRAND_ICON_BASE}/${file.replace(/^\//, '')}`;
}
