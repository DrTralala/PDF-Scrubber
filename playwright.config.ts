import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './apps/m0-harness/tests',
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: 'http://[::1]:4173',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run dev --workspace apps/m0-harness -- --host ::1 --port 4173',
    url: 'http://[::1]:4173',
    reuseExistingServer: false,
  },
});
