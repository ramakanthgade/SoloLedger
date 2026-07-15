import os from 'os';
import path from 'path';
import { defineConfig } from 'vitest/config';

/**
 * Server unit tests. Point DATA_DIR at an ephemeral tmp dir so the one-time
 * store.ts module-init (which creates store.json) never touches the real data
 * directory. Individual tests override DATA_DIR + reset modules as needed.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    env: {
      NODE_ENV: 'test',
      DATA_DIR: path.join(os.tmpdir(), 'sololedger-server-test-data')
    }
  }
});
