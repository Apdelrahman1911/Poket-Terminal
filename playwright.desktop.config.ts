import { defineConfig } from '@playwright/test';
import path from 'node:path';
export default defineConfig({ testDir: './tests', testMatch: '**/*.browser.ts', fullyParallel: false, workers: 1, retries: 0,
  timeout: 90000, reporter: [['list'], ['json', { outputFile: '.runtime/evidence/desktop-playwright.json' }]],
  outputDir: '.runtime/tests/desktop-playwright-output',
  use: { headless: true, ignoreHTTPSErrors: true, trace: 'off', screenshot: 'only-on-failure',
    launchOptions: { executablePath: path.resolve('desktop/tests/browser-launcher.py'), chromiumSandbox: true } } });
