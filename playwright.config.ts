import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', testMatch: '**/browser.spec.ts', workers: 1, timeout: 60_000,
  use: { headless: true, launchOptions: { executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] } },
  reporter: 'list'
});
