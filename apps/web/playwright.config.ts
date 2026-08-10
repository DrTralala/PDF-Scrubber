import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: 'http://[::1]:5173',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm start -- --host ::1 --mode test',
    cwd: resolve(import.meta.dirname, '../..'),
    url: 'http://[::1]:5173',
    reuseExistingServer: false,
  },
});
