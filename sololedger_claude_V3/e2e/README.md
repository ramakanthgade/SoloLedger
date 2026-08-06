# Integrated browser gate

`npm run test:browser` builds the production PWA with the B6 browser-test seed hook and
the wallet/DeFi rollout enabled, then runs Chromium against the normal application UI.
It verifies rendered Dashboard and Connections totals, persisted ownership/safety/pair/
classification state, source presentation, light/dark and desktop/mobile behavior,
service-worker offline reload, and the online-only exchange bundle boundary.

The hook is compile-time gated by `VITE_B6_BROWSER_TEST=true`; ordinary development and
production builds do not expose it. CI and the GitHub Pages release workflow run this
browser gate explicitly before accepting or deploying a build.
