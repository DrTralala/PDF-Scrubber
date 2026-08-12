import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.PDF_SCRUBBER_CLI_URL;
if (baseURL === undefined) {
  throw new Error('PDF_SCRUBBER_CLI_URL is required');
}

export default defineConfig({
  testDir: './tests',
  testMatch: 'package-smoke.spec.ts',
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
