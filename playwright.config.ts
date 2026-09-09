import { defineConfig } from '@playwright/test';
import path from 'node:path';
process.env.PLAYWRIGHT_BROWSERS_PATH = path.resolve('.runtime/browsers');
export default defineConfig({ testDir: './tests', testMatch: '**/*.browser.ts', fullyParallel: false, workers: 1, timeout: 60000,
  reporter: [['list'], ['json', { outputFile: '.runtime/evidence/playwright-results.json' }]],
  outputDir: '.runtime/tests/playwright-output', use: { headless: true, ignoreHTTPSErrors: true, trace: 'off', screenshot: 'only-on-failure', launchOptions: { executablePath: path.resolve('desktop/tests/browser-launcher.py'), chromiumSandbox: true } } });
