import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.PDF_SCRUBBER_CLI_URL;
const outputDir = process.env.PDF_SCRUBBER_PLAYWRIGHT_OUTPUT;
if (baseURL === undefined) {
  throw new Error('PDF_SCRUBBER_CLI_URL is required');
}
if (outputDir === undefined) {
  throw new Error('PDF_SCRUBBER_PLAYWRIGHT_OUTPUT is required');
}

export default defineConfig({
  testDir: './tests',
  outputDir,
  testMatch: 'package-smoke.spec.ts',
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
