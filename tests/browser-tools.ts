import type { Page, BrowserContext } from '@playwright/test';
import { TEST_PASSWORD } from './helpers.js';
export async function installCounters(context: BrowserContext) {
  await context.addInitScript(() => {
    const counters = { liveSockets: 0, createdSockets: 0, closedSockets: 0, receivedBytes: 0, inputMessages: 0 };
    (window as any).__testResources = counters;
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols); counters.liveSockets++; counters.createdSockets++;
        this.addEventListener('close', () => { counters.liveSockets--; counters.closedSockets++; }, { once: true });
        this.addEventListener('message', event => { if (event.data instanceof ArrayBuffer) counters.receivedBytes += event.data.byteLength; });
      }
      override send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        if (typeof data === 'string' && data.startsWith('{"type":"input"')) counters.inputMessages++;
        super.send(data);
      }
    };
  });
}
export async function browserLogin(page: Page, origin: string) {
  await page.goto(origin); await page.getByLabel('Password', { exact: true }).fill(TEST_PASSWORD); await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await page.getByRole('button', { name: 'Log out', exact: true }).waitFor();
}
export async function browserApi(page: Page, path: string, method = 'GET', body?: object) {
  return page.evaluate(async ({ path, method, body }) => {
    const auth = await (await fetch('/api/auth')).json();
    const response = await fetch(path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(auth.csrf ? { 'X-CSRF-Token': auth.csrf } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json() };
  }, { path, method, body });
}
export async function createShell(page: Page, label = 'Synthetic shell') {
  const result = await browserApi(page, '/api/sessions', 'POST', { kind: 'shell', label });
  if (result.status !== 201) throw new Error(`Synthetic shell create failed ${result.status}`);
  return result.data.session;
}
export async function selectSession(page: Page, id: string) {
  await page.locator(`[data-session-id="${id}"]`).click();
  await page.waitForFunction(() => document.querySelectorAll('.xterm').length === 1 && (window as any).__testResources.liveSockets === 1);
  await page.getByTestId('connection-status').filter({ hasText: 'You control input' }).waitFor();
}
export async function typeCommand(page: Page, command: string) {
  const input = page.locator('.xterm-helper-textarea'); await input.focus(); await input.fill(command); await input.press('Enter');
}
export async function resources(page: Page) {
  return page.evaluate(() => ({ ...(window as any).__testResources, xterms: document.querySelectorAll('.xterm').length, nodes: document.getElementsByTagName('*').length, visible: document.visibilityState }));
}
