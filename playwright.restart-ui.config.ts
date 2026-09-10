import { defineConfig } from '@playwright/test';
// Built client with synthetic metadata/socket fixtures only; no owner login,
// live terminal, model inference, or production desktop is accessed.
export default defineConfig({
  testDir: './tests', testMatch: 'codex-restart.browser.ts', workers: 1, retries: 0,
  timeout: 40000, reporter: 'list', outputDir: '.runtime/tests/codex-restart-ui',
  use: { headless: true, viewport: { width: 390, height: 844 },
    launchOptions: { chromiumSandbox: true, executablePath: process.env.PT_UI_BROWSER_EXECUTABLE } },
});
