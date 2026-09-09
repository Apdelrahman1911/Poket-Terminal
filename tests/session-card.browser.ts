import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { foreground } from './foreground.js';
import { browserLogin, createShell, installCounters, resources, selectSession } from './browser-tools.js';
import { until } from './helpers.js';
import { attachmentPids, descendants } from '../scripts/memory.js';
import { ROOT } from '../src/server/config.js';

test('Cards: accessible mobile/desktop state colors, independent selection/focus, stale distinction and unchanged terminal resources', async ({ page, context }) => {
  const backend = await foreground('card-colors'), evidence: Record<string, unknown> = {};
  const ptyFds = () => fs.readdirSync(`/proc/${backend.backendPid}/fd`).filter(fd => { try { return /^\/dev\/pts\/ptmx$|^\/dev\/ptmx$/.test(fs.readlinkSync(`/proc/${backend.backendPid}/fd/${fd}`)); } catch { return false; } });
  let catalogs = 0, fail = false;
  page.on('request', req => { if (req.method() === 'GET' && new URL(req.url()).pathname === '/api/sessions') catalogs++; });
  try {
    await installCounters(context); await page.setViewportSize({ width: 390, height: 844 }); await browserLogin(page, backend.config.origin);
    const row = await createShell(page, 'Older Codex fixture');
    // Metadata-only synthetic matrix. Only the real disposable shell is attachable;
    // no production titles/output/DB and no Codex/model process is involved.
    const variants = [
      { label: 'Working', state: 'running', lifecycle: 'running', activity: 'working', tone: 'working' },
      { label: 'Input needed', state: 'running', lifecycle: 'running', activity: 'awaiting_input', tone: 'input' },
      { label: 'Ready', state: 'running', lifecycle: 'running', activity: 'ready', tone: 'ready' },
      { label: 'Starting', state: 'starting', lifecycle: 'starting', activity: 'working', tone: 'starting' },
      { label: 'Stopping', state: 'running', lifecycle: 'stopping', activity: 'working', tone: 'stopping' },
      { label: 'Stopped', state: 'stopped', lifecycle: 'stopped', activity: 'working', tone: 'stopped' },
      { label: 'Exited', state: 'stopped', lifecycle: 'exited', activity: 'ready', tone: 'stopped' },
      { label: 'Error', state: 'stopped', lifecycle: 'error', activity: 'working', tone: 'error' },
      { label: 'Unconfirmed', state: 'running', lifecycle: 'unknown', activity: 'working', tone: 'stale' },
      { label: 'Generic shell', state: 'running', lifecycle: 'running', activity: 'unavailable', tone: 'unreported' },
    ];
    const entries = [{ ...row, kind: 'codex', activity: 'unavailable', tone: 'unreported' }, ...variants.map((v, i) => ({ ...row, ...v, id: (9000 + i).toString(16).padStart(32, '0') }))];
    await page.route(/\/api\/sessions(?:\?.*)?$/, async route => {
      if (route.request().method() !== 'GET') return route.continue();
      if (fail) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"synthetic_inventory_unavailable"}' });
      await route.fulfill({ json: { sessions: entries, selectedSession: row, nextOffset: null, runningCount: 1, limit: 20 } });
    });
    await page.getByRole('button', { name: 'Refresh sessions', exact: true }).click();
    const card = page.locator(`[data-session-id="${row.id}"]`);
    await expect(card).toHaveAttribute('data-state', 'unreported'); await expect(card.getByTestId('activity')).toHaveText('Running · activity not reported');
    const beforeSelection = await card.evaluate(el => { const s = getComputedStyle(el); return { color: s.borderLeftColor, background: s.backgroundColor, style: s.borderLeftStyle }; });
    await selectSession(page, row.id); await expect(card).toHaveAttribute('data-state', 'unreported');
    await page.getByRole('button', { name: 'New session', exact: true }).focus(); await page.keyboard.press('Tab');
    await expect(card).toBeFocused(); await expect(card).toHaveAttribute('aria-current', 'true');
    const selected = await card.evaluate(el => { const s = getComputedStyle(el); return { color: s.borderLeftColor, background: s.backgroundColor, style: s.borderLeftStyle, selectedBorder: s.borderRightColor, focusWidth: s.outlineWidth, focusStyle: s.outlineStyle }; });
    expect({ color: selected.color, background: selected.background, style: selected.style }).toEqual(beforeSelection);
    expect(selected.color).not.toBe(selected.selectedBorder); expect(selected.style).toBe('dashed'); expect(selected.focusWidth).toBe('2px'); expect(selected.focusStyle).toBe('solid');
    const colors = new Map<string, string>();
    for (const entry of entries) {
      const item = page.locator(`[data-session-id="${entry.id}"]`); await expect(item).toHaveAttribute('data-state', entry.tone);
      const style = await item.evaluate(el => {
        const s = getComputedStyle(el), label = getComputedStyle(el.querySelector('.session-state')!);
        const luminance = (rgb: string) => rgb.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);
        const light = luminance(label.color), dark = luminance(s.backgroundColor);
        return { color: s.borderLeftColor, contrast: (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05), animation: s.animationName, transition: s.transitionDuration, text: el.querySelector('.session-state')!.textContent };
      });
      expect(style.contrast).toBeGreaterThanOrEqual(4.5); expect(style.text!.length).toBeGreaterThan(3); expect(style.animation).toBe('none'); expect(style.transition).toBe('0s');
      colors.set(entry.tone, style.color);
    }
    expect(colors.size).toBe(9); expect(new Set(colors.values()).size).toBe(9); await expect(page.locator('.session-item')).toHaveCount(11);
    await card.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(ROOT, '.runtime/evidence/card-colors-mobile.png') });
    await page.setViewportSize({ width: 1200, height: 1250 }); await page.screenshot({ path: path.join(ROOT, '.runtime/evidence/card-colors-desktop.png') });
    const native = attachmentPids(descendants(backend.backendPid)); expect(native).toHaveLength(1); expect(ptyFds()).toHaveLength(1);
    const before = await resources(page), requestCount = catalogs;
    await page.evaluate(() => { (window as any).__keptTerminal = document.querySelector('.xterm'); });
    await page.waitForTimeout(3300); expect(catalogs - requestCount).toBeGreaterThanOrEqual(1); expect(catalogs - requestCount).toBeLessThanOrEqual(2);
    fail = true; await page.getByRole('button', { name: 'Refresh sessions', exact: true }).click(); await expect(card).toHaveAttribute('data-state', 'stale'); await expect(card.getByTestId('activity')).toHaveText('Status stale · refreshing');
    expect((await resources(page)).createdSockets).toBe(before.createdSockets); expect(await page.evaluate(() => document.querySelector('.xterm') === (window as any).__keptTerminal)).toBe(true);
    expect(attachmentPids(descendants(backend.backendPid))).toEqual(native); expect(ptyFds()).toHaveLength(1);
    fail = false; await page.getByRole('button', { name: 'Refresh sessions', exact: true }).click(); await expect(card).toHaveAttribute('data-state', 'unreported');
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))); await expect(page.locator('.xterm')).toHaveCount(0);
    await until(() => attachmentPids(descendants(backend.backendPid)).length === 0 && ptyFds().length === 0, 7000);
    const hidden = catalogs; await page.waitForTimeout(3200); expect(catalogs).toBe(hidden); expect((await resources(page)).liveSockets).toBe(0);
    Object.assign(evidence, { staticDistinctTones: colors.size, labelContrastMinimum: 4.5, accessibleLabels: true, selectedAccentPreserved: true, independentKeyboardFocus: true, healthyLegacyAndShellNotFailure: true, staleDifferent: true, oneXtermAndNativeAttachment: true, unchangedAttachmentAcrossRefresh: true, backgroundPolls: 0, nativeChildrenAndPtMxFdsAfterHide: 0 });
  } finally {
    await page.close(); await until(() => attachmentPids(descendants(backend.backendPid)).length === 0 && ptyFds().length === 0, 7000);
    const close = await backend.close();
    fs.writeFileSync(path.join(ROOT, '.runtime/evidence/card-colors-browser.json'), JSON.stringify({ at: new Date().toISOString(), fixtureOnly: true, productionBuild: true, minimalEnvironment: true, evidence, close }, null, 2), { mode: 0o600 });
    expect(close.graceful).toBe(true);
  }
});
