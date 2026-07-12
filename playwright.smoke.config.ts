import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './smoke',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: 'list',
  timeout: 30_000,
  use: {
    ...devices['Desktop Chrome'],
    trace: 'retain-on-failure',
  },
});
