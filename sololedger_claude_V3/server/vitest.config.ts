import os from 'os';
import path from 'path';
import { defineConfig } from 'vitest/config';

/**
 * Server unit tests. Point DATA_DIR at an ephemeral tmp dir so the one-time
 * store.ts module-init (which creates store.json) never touches the real data
 * directory. Individual tests override DATA_DIR + reset modules as needed.
 */
export default defineConfig({
  // The server is a pure Node/Express workspace with no CSS. Disable PostCSS so
  // Vitest does not walk up and load the client's root `postcss.config.js`,
  // which requires `tailwindcss` — a client-only dependency not installed in
  // `server/node_modules` (that lookup is what broke the server CI job).
  css: { postcss: { plugins: [] } },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    env: {
      NODE_ENV: 'test',
      DATA_DIR: path.join(os.tmpdir(), 'sololedger-server-test-data')
    }
  }
});
