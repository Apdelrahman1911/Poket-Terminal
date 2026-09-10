import { defineConfig } from '@playwright/test';

// Static client + synthetic RFB only: no VPS login, owner data, native desktop,
// root privileges, provider credentials, or paid model calls are involved.
export default defineConfig({
  testDir: './desktop/tests', testMatch: 'ui.browser.mjs', workers: 1, retries: 0,
  timeout: 45000, reporter: 'list', outputDir: '.runtime/tests/desktop-ui',
  use: { headless: true, viewport: { width: 1440, height: 900 },
    launchOptions: { chromiumSandbox: true, executablePath: process.env.PT_UI_BROWSER_EXECUTABLE } },
});
