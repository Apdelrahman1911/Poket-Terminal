import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { nativeRunner, NativeInput, NativeRunner } from '../src/server/native-input.js';
import { harness, until, delay } from './helpers.js';
import { attachmentPids, descendants } from '../scripts/memory.js';

const ptmx = () => fs.readdirSync('/proc/self/fd').filter(fd => { try { return /\/dev\/(pts\/)?ptmx$/.test(fs.readlinkSync('/proc/self/fd/' + fd)); } catch { return false; } }).length;
async function receiver(h: Awaited<ReturnType<typeof harness>>) {
  const row = await h.service.sessions.create({ kind: 'shell', label: 'Synthetic raw receiver' });
  const file = path.join(h.config.defaultCwd, 'received-' + row.id), ready = file + '.ready', script = file + '.py';
  fs.writeFileSync(script, `import os,tty\ntty.setraw(0)\nos.write(1,b'\\x1b[?2004h')\nopen(${JSON.stringify(ready)},'w').close()\nf=open(${JSON.stringify(file)},'wb',buffering=0)\nn=0\nwhile n<32768:\n b=os.read(0,min(4096,32768-n))\n if not b: break\n f.write(b);n+=len(b)\n`, { mode: 0o600 });
  await h.service.sessions.tmux(['respawn-pane', '-k', '-t', `=${row.tmux_name}:0.0`, '--', '/usr/bin/python3', script]);
  await until(() => fs.existsSync(ready));
  await delay(30);
  return { row, file, bytes: () => fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0) };
}

test('Telegram native input: stdin literal UTF-8/bracketed paste + exact keys/prompt, no shell argv, no PTY, native buffer cleanup', async () => {
  const h = await harness('tg-literal', { initialize: false });
  const args: string[][] = []; let stdinBytes = 0;
  const original = nativeRunner(h.service.sessions);
  const input = new NativeInput(h.service.sessions, async (argv, stdin, signal) => { args.push(argv); stdinBytes = Math.max(stdinBytes, stdin?.length || 0); return original(argv, stdin, signal); });
  try {
    const f = await receiver(h), target = await input.target(f.row.id), signal = new AbortController().signal;
    const fdBaseline = ptmx(), nativeBaseline = attachmentPids(descendants(process.pid));
    const text = `/stop is literal; 'quoted' \"double\" $() $(touch SHOULD_NOT_EXIST) hé🙂 中文\nsecond\tline`;
    await input.perform(target, { kind: 'text', text }, () => {}, signal);
    const expected = Buffer.from('\x1b[200~' + text + '\x1b[201~');
    await until(() => f.bytes().length >= expected.length);
    assert.deepEqual(f.bytes(), expected); assert(!fs.existsSync(path.join(h.config.defaultCwd, 'SHOULD_NOT_EXIST')));
    assert(args.every(a => !a.some(value => value.includes('quoted') || value.includes('SHOULD_NOT_EXIST')))); assert.equal(stdinBytes, Buffer.byteLength(text));
    const start = f.bytes().length;
    for (const key of ['Enter', 'Escape', 'Tab', 'C-c', 'Up', 'Down', 'Left', 'Right'] as const) await input.perform(target, { kind: 'key', key }, () => {}, signal);
    await until(() => f.bytes().length >= start + 16);
    assert.deepEqual(f.bytes().subarray(start), Buffer.from('\r\x1b\t\x03\x1b[A\x1b[B\x1b[D\x1b[C'));
    const before = f.bytes().length; await input.perform(target, { kind: 'prompt', text: 'literal prompt' }, () => {}, signal);
    await until(() => f.bytes().length > before);
    assert.deepEqual(f.bytes().subarray(before), Buffer.from('\x1b[200~literal prompt\x1b[201~\r'));
    assert.deepEqual(input.stats(), { operations: 0, inputBytes: 0, transientBuffers: 0 });
    assert.equal(ptmx(), fdBaseline); assert.deepEqual(attachmentPids(descendants(process.pid)), nativeBaseline);
    assert.equal(h.service.bridges.stats().created, 0);
    assert(!((await h.service.sessions.tmux(['list-buffers', '-F', '#{buffer_name}'])).includes('pocketterminal_telegram_input')));
  } finally { await h.close(); }
});

test('Telegram native target/copy-mode: pane/window changes and copy mode reject keys/text; Exit history never injects shell keys', async () => {
  const h = await harness('tg-target', { initialize: false }), input = new NativeInput(h.service.sessions), signal = new AbortController().signal;
  try {
    const f = await receiver(h), target = await input.target(f.row.id);
    await h.service.sessions.tmux(['copy-mode', '-t', target.pane]);
    await assert.rejects(input.perform(target, { kind: 'text', text: 'never sent' }, () => {}, signal), /target_changed_or_in_history/);
    await assert.rejects(input.perform(target, { kind: 'key', key: 'C-c' }, () => {}, signal), /target_changed_or_in_history/);
    assert.equal(f.bytes().length, 0);
    await input.perform(target, { kind: 'exit_history' }, () => {}, signal);
    assert.equal((await h.service.sessions.tmux(['display-message', '-p', '-t', target.pane, '#{pane_in_mode}'])).trim(), '0');
    await input.perform(target, { kind: 'exit_history' }, () => {}, signal); assert.equal(f.bytes().length, 0);
    await h.service.sessions.tmux(['split-window', '-t', target.pane, '--', '/bin/sleep', '300']);
    await assert.rejects(input.perform(target, { kind: 'key', key: 'Enter' }, () => {}, signal), /target_changed_or_in_history/);
    await h.service.sessions.tmux(['select-pane', '-t', target.pane]);
    await h.service.sessions.tmux(['new-window', '-t', `=${f.row.tmux_name}`, '--', '/bin/sleep', '300']);
    await assert.rejects(input.perform(target, { kind: 'text', text: 'wrong window' }, () => {}, signal), /target_changed_or_in_history/);
    assert.equal(f.bytes().length, 0);
    await h.service.sessions.tmux(['select-window', '-t', target.window]);
    for (const text of ['', 'x'.repeat(4097), '🙂'.repeat(1100), 'a\x1bb', 'a\x00b', 'a\rb']) await assert.rejects(input.perform(target, { kind: 'text', text }, () => {}, signal), /invalid_telegram_text/);
    assert.deepEqual(input.stats(), { operations: 0, inputBytes: 0, transientBuffers: 0 });
  } finally { await h.close(); }
});

test('Telegram/browser ownership: explicit takeover, view-only rejection, take-back fences delayed write, no retry on uncertain write/disable', async () => {
  let intercepted: 'none' | 'load' | 'paste' = 'none', release: (() => void) | undefined;
  let runner: NativeRunner | undefined, pasted = 0;
  const h = await harness('tg-ownership', { nativeRunner: async (args, input, signal) => {
    if (intercepted === 'load' && args[0] === 'load-buffer') await new Promise<void>(resolve => { release = resolve; });
    const result = await runner!(args, input, signal);
    if (args[0] === 'if-shell' && args.join(' ').includes('paste-buffer')) {
      pasted++;
      if (intercepted === 'paste') throw new Error('synthetic response lost AFTER write');
    }
    return result;
  } });
  runner = nativeRunner(h.service.sessions);
  try {
    await h.login(); const f = await receiver(h), target = await h.service.bridges.telegramTarget(f.row.id);
    const browser = await h.ws(f.row.id); await until(() => browser.control);
    await assert.rejects(h.service.bridges.takeTelegram(f.row.id, ''), /controller_changed/);
    const stamp = await h.service.bridges.takeTelegram(f.row.id, h.service.bridges.controller(f.row.id).stamp);
    await until(() => !browser.control);
    browser.send({ type: 'input', data: 'not allowed' }); await until(() => browser.messages.some((m: any) => m.code === 'view_only'));
    assert.equal(f.bytes().length, 0);
    intercepted = 'load';
    const writing = h.service.bridges.telegramInput(target, stamp, { kind: 'text', text: 'stale should not write' }, () => true);
    const failed = assert.rejects(writing, /control_changed_no_replay/);
    await until(() => !!release); browser.send({ type: 'take_control' });
    await delay(30); assert.equal(browser.control, false); release!(); await failed;
    await until(() => browser.control); assert.equal(f.bytes().length, 0); assert.equal(pasted, 0);
    intercepted = 'paste';
    const next = await h.service.bridges.takeTelegram(f.row.id, h.service.bridges.controller(f.row.id).stamp);
    await assert.rejects(h.service.bridges.telegramInput(target, next, { kind: 'prompt', text: 'one literal write' }, () => true), /response lost/);
    assert.equal(pasted, 1); assert.deepEqual(f.bytes(), Buffer.from('\x1b[200~one literal write\x1b[201~')); // no Enter after uncertainty
    await assert.rejects(h.service.bridges.telegramInput(target, next, { kind: 'text', text: 'disabled' }, () => false), /control_changed/);
    await h.service.bridges.releaseTelegram(); await until(() => browser.control);
    browser.socket.close(); await until(() => h.service.bridges.stats().ptys === 0 && h.service.bridges.stats().connections === 0);
    assert.equal(ptmx(), 0); assert.equal(attachmentPids(descendants(process.pid)).length, 0);
    const stats = h.service.bridges.stats(); assert.equal(stats.created, stats.disposed); assert.equal(stats.telegramControllers, 0);
    assert.deepEqual(stats.telegramInput, { operations: 0, inputBytes: 0, transientBuffers: 0 });
    process.kill(Number(target.pid), 0);
  } finally { release?.(); await h.close(); }
});

test('Telegram crash orphan: a fresh process deletes only the reserved paste buffer without reading/replaying it or touching job identity', async () => {
  const h = await harness('tg-orphan', { initialize: false });
  try {
    const f = await receiver(h), target = await h.service.bridges.telegramTarget(f.row.id);
    const child = spawn(process.execPath, ['--input-type=module', '-e', `import {spawnSync} from 'node:child_process'; const r=spawnSync('tmux',['-L',process.argv[1],'load-buffer','-b','pocketterminal_telegram_input_v1','-'],{input:Buffer.from('stale synthetic never replay'),stdio:['pipe','ignore','ignore']}); if(r.status!==0) process.exit(2); process.kill(process.pid,'SIGKILL');`, h.config.tmuxSocket], { stdio: 'ignore' });
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    assert.equal(exit.signal, 'SIGKILL');
    await h.service.sessions.tmux(['set-buffer', '-b', 'unrelated_synthetic_buffer', 'keep dummy']);
    assert.match(await h.service.sessions.tmux(['list-buffers', '-F', '#{buffer_name}']), /pocketterminal_telegram_input_v1/);
    const nonpolling = new NativeInput(h.service.sessions); await nonpolling.clear();
    assert.match(await h.service.sessions.tmux(['list-buffers', '-F', '#{buffer_name}']), /pocketterminal_telegram_input_v1/, 'non-owning instance must not clear another poller buffer');
    const cleaned = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `import {NativeInput} from './src/server/native-input.ts'; import{TelegramLock} from './src/server/telegram-state.ts'; const lock=new TelegramLock(process.argv[2]+'/poller'); if(!await lock.acquire())process.exit(2); const input=new NativeInput({config:{tmuxSocket:process.argv[1]}}); try{await input.clear(true); process.stdout.write(JSON.stringify(input.stats()));}finally{await lock.close();}`, h.config.tmuxSocket, path.join(h.config.dataDir, 'telegram')], { cwd: h.config.root, timeout: 5000, maxBuffer: 4096 });
    assert.deepEqual(JSON.parse(cleaned.stdout), { operations: 0, inputBytes: 0, transientBuffers: 0 });
    const names = await h.service.sessions.tmux(['list-buffers', '-F', '#{buffer_name}']);
    assert(!names.includes('pocketterminal_telegram_input_v1')); assert(names.includes('unrelated_synthetic_buffer'));
    assert.equal(f.bytes().length, 0); process.kill(Number(target.pid), 0);
    assert.equal((await h.service.bridges.telegramTarget(f.row.id)).pid, target.pid);
  } finally { await h.close(); }
});
