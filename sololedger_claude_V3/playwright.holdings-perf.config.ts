import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './perf',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:4183',
    headless: true,
    viewport: { width: 1440, height: 900 },
    trace: 'off',
    video: 'off',
    screenshot: 'off'
  },
  projects: [{
    name: 'chromium',
    use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }
  }],
  webServer: {
    command: 'npm run serve:holdings-perf',
    url: 'http://127.0.0.1:4183/holdings-perf.html',
    reuseExistingServer: false,
    timeout: 120_000
  }
});
