import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') }
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    include: [
      'src/lib/ledger/postingBalances.perf.test.ts',
      'src/lib/internalTransfers/matcher.perf.test.ts',
      'src/lib/portfolio/economicExposureProjection.perf.test.ts',
      'src/components/connections/connectionWorkspaceCollection.perf.test.ts'
    ],
    exclude: [],
    fileParallelism: false,
    maxWorkers: 1
  }
});
