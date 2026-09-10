import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { desktopOptIn } from './desktop-opt-in.js';
import { readFleet, type FleetConfig } from './telegram-fleet-state.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const LIMITS = Object.freeze({ sessions: 20, attachments: 32, scrollback: 500, history: 2000,
  cols: 240, rows: 100, outstanding: 128 * 1024, transport: 256 * 1024,
  frame: 8 * 1024, inbound: 16 * 1024, input: 4 * 1024, inputPerSecond: 32 * 1024,
  ackMs: 5000, heartbeatMs: 1000, authMs: 12 * 60 * 60 * 1000, authRecords: 64 });
// Use this host owner's privately authenticated Codex defaults unless explicitly
// overridden. Full-access owner tooling is intentional, not a multi-user sandbox.
export const CODEX_ARGS = Object.freeze(['-c', 'tui.terminal_title=["activity","status"]',
  '--sandbox', 'danger-full-access', '--ask-for-approval', 'never']);
export function codexArgs(env: NodeJS.ProcessEnv): readonly string[] {
  const args: string[] = [];
  if (env.PT_CODEX_MODEL) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(env.PT_CODEX_MODEL)) throw new Error('Invalid PT_CODEX_MODEL');
    args.push('-m', env.PT_CODEX_MODEL);
  }
  if (env.PT_CODEX_PROVIDER) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(env.PT_CODEX_PROVIDER)) throw new Error('Invalid PT_CODEX_PROVIDER');
    args.push('-c', 'model_provider=' + JSON.stringify(env.PT_CODEX_PROVIDER));
  }
  if (env.PT_CODEX_REASONING_EFFORT) {
    // "max" is for compatible private/custom installations, not a promise of
    // support by generally available Codex/models. No default is forced.
    if (!['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(env.PT_CODEX_REASONING_EFFORT)) throw new Error('Invalid PT_CODEX_REASONING_EFFORT');
    args.push('-c', 'model_reasoning_effort=' + JSON.stringify(env.PT_CODEX_REASONING_EFFORT),
      '-c', 'plan_mode_reasoning_effort=' + JSON.stringify(env.PT_CODEX_REASONING_EFFORT));
  }
  return Object.freeze([...args, ...CODEX_ARGS]);
}
export interface TelegramBotIdentity { readonly id: number; readonly username: string }
export function telegramBotFromEnv(env: NodeJS.ProcessEnv): TelegramBotIdentity | undefined {
  const username = env.PT_TELEGRAM_BOT_USERNAME, id = env.PT_TELEGRAM_BOT_ID;
  if (!username && !id) return undefined; // config alone never pairs or enables
  if (!username || !/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(username) || !/bot$/i.test(username)
      || !id || !/^[1-9][0-9]{0,15}$/.test(id) || !Number.isSafeInteger(Number(id))) throw new Error('Set exact PT_TELEGRAM_BOT_USERNAME (without @) and numeric PT_TELEGRAM_BOT_ID together');
  return Object.freeze({ username, id: Number(id) });
}
function sshEndpoint(value: string | undefined, jump = false) {
  if (!value) return undefined;
  // Display-only SSH hints. One DNS/IPv4 host, optional user and jump port;
  // no option prefixes, shell metacharacters, whitespace or multi-hop syntax.
  const pattern = jump ? /^(?:[A-Za-z_][A-Za-z0-9_.-]{0,31}@)?[A-Za-z0-9][A-Za-z0-9.-]{0,252}(?::([0-9]{1,5}))?$/ : /^(?:[A-Za-z_][A-Za-z0-9_.-]{0,31}@)?[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
  const match = value.match(pattern);
  if (!match || (match[1] && (Number(match[1]) < 1 || Number(match[1]) > 65535))) throw new Error('Invalid SSH target/jump hint');
  return value;
}
function absoluteDirectory(value: string) {
  if (!path.isAbsolute(value) || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Project directories must be absolute paths');
  return path.resolve(value);
}
export interface Config {
  root: string; dataDir: string; origin: string; host: string; port: number;
  tmuxSocket: string; projectRoot: string; defaultCwd: string; shell: string;
  testMode: boolean; tls?: { key: string; cert: string }; ackMs: number;
  codexArgs?: readonly string[]; sshTarget?: string; sshJump?: string; telegramBot?: TelegramBotIdentity;
  telegramFleet?: FleetConfig;
  desktop?: { assetsDir: string; socketPath: string; uid: number; startCommand: 'start' | 'test-start'; autoStart?: boolean };
}
export function sshHint(config: Config, tmuxName: string) {
  if (!/^pt_[a-f0-9]{32}$/.test(tmuxName)) throw new Error('Invalid managed tmux name');
  const attach = `tmux -L ${config.tmuxSocket} attach -t =${tmuxName}`;
  return config.sshTarget ? `ssh -t ${config.sshJump ? '-J ' + config.sshJump + ' ' : ''}-- ${config.sshTarget} '${attach}'` : attach;
}
export function configFromEnv(env = process.env): Config {
  const testMode = env.PT_TEST_MODE === '1';
  const dataDir = path.resolve(env.PT_DATA_DIR || path.join(ROOT, '.runtime/production'));
  const origin = env.PT_ORIGIN;
  if (!origin) throw new Error('PT_ORIGIN is required: the exact public HTTPS origin');
  const parsed = new URL(origin);
  if (parsed.origin !== origin || parsed.username || parsed.password || parsed.protocol !== 'https:' || parsed.hostname.includes('*')) throw new Error('PT_ORIGIN must be an exact HTTPS origin');
  const host = env.PT_HOST || '127.0.0.1';
  const port = Number(env.PT_PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  const tmuxSocket = env.PT_TMUX_SOCKET || 'pocketterminal';
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tmuxSocket)) throw new Error('Invalid tmux socket name');
  if (testMode && (!dataDir.startsWith(path.join(ROOT, '.runtime/tests/')) || host !== '127.0.0.1' || !tmuxSocket.startsWith('pt-test-'))) throw new Error('Test mode requires isolated app-owned state, socket and loopback');
  if (!testMode && tmuxSocket !== 'pocketterminal') throw new Error('Production tmux socket is fixed');
  const projectRoot = testMode ? path.join(dataDir, 'projects') : absoluteDirectory(env.PT_PROJECT_ROOT || path.join(os.homedir(), 'projects'));
  const defaultCwd = testMode ? path.join(projectRoot, 'fixture') : absoluteDirectory(env.PT_DEFAULT_CWD || path.join(projectRoot, 'default'));
  if (path.dirname(defaultCwd) !== projectRoot) throw new Error('PT_DEFAULT_CWD must be an immediate child of PT_PROJECT_ROOT; realpath confinement is checked before launch');
  const sshTarget = sshEndpoint(env.PT_SSH_TARGET), sshJump = sshEndpoint(env.PT_SSH_JUMP, true);
  if (sshJump && !sshTarget) throw new Error('PT_SSH_JUMP requires PT_SSH_TARGET');
  const tls = testMode && env.PT_TEST_TLS_KEY && env.PT_TEST_TLS_CERT ? { key: env.PT_TEST_TLS_KEY, cert: env.PT_TEST_TLS_CERT } : undefined;
  let desktop: Config['desktop'];
  const optIn = testMode || env.PT_DESKTOP_ENABLED === '0' ? { enabled: false, autoStart: false } : desktopOptIn();
  if (env.PT_DESKTOP_ENABLED === '1' || (env.PT_DESKTOP_ENABLED === undefined && optIn.enabled)) {
    const name = testMode ? 'pocketdesktop-test' : 'pocketdesktop';
    const assetsDir = testMode && env.PT_TEST_DESKTOP_ASSETS ? path.resolve(env.PT_TEST_DESKTOP_ASSETS) : '/opt/pocketdesktop/current/client';
    if (testMode && env.PT_TEST_DESKTOP_ASSETS && !assetsDir.startsWith(path.join(ROOT, '.runtime/'))) throw new Error('Test desktop assets must be isolated');
    const uid = fs.statSync('/var/lib/' + name).uid;
    if (!uid) throw new Error('Desktop requires a provisioned non-root account');
    desktop = { assetsDir, socketPath: '/run/' + name + '/rfb.sock', uid, startCommand: testMode ? 'test-start' : 'start', autoStart: !testMode && optIn.autoStart };
  }
  const config: Config = { root: ROOT, dataDir, origin, host, port, tmuxSocket, projectRoot, defaultCwd, shell: '/bin/bash', testMode, tls, ackMs: LIMITS.ackMs,
    desktop, codexArgs: codexArgs(env), sshTarget, sshJump, telegramBot: telegramBotFromEnv(env) };
  config.telegramFleet = readFleet(config);
  if (config.telegramFleet) {
    const pin = config.telegramFleet.binding.bot;
    if (config.telegramBot && (config.telegramBot.id !== pin.id || config.telegramBot.username !== pin.username)) throw new Error('Fleet bot identity does not match configured pins');
    config.telegramBot = pin;
  }
  return config;
}
