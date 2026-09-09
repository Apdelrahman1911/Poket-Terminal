// Telegram's command menu contains intents, never a mutable selected terminal.
export const SESSION_COMMANDS = Object.freeze({
  select: 'Open session controls', prompt: 'Send a prompt followed by Enter',
  send: 'Send text without Enter', paste: 'Paste text without Enter',
  output: 'Show recent terminal output', rename: 'Rename a session',
  take: 'Take terminal input control', release: 'Release Telegram input control',
  enter: 'Send Enter', esc: 'Send Escape', tab: 'Send Tab',
  up: 'Send Up arrow', down: 'Send Down arrow', left: 'Send Left arrow', right: 'Send Right arrow',
  interrupt: 'Send Ctrl+C to interrupt', live: 'Exit terminal history mode',
  stop: 'Stop a session (confirmation required)', delete: 'Delete a stopped session entry',
});
export type SessionCommand = keyof typeof SESSION_COMMANDS;
export const sessionCommand = (value: string): value is SessionCommand => Object.hasOwn(SESSION_COMMANDS, value);
export const BOT_COMMANDS = Object.freeze([
  { command: 'sessions', description: 'List sessions and open their controls' },
  { command: 'new', description: 'Create a Codex or shell session' },
  ...Object.entries(SESSION_COMMANDS).map(([command, description]) => ({ command, description })),
  { command: 'website', description: 'Open the live terminal website' },
  { command: 'notifications', description: 'Manage session notifications' },
  { command: 'cancel', description: 'Cancel pending bot actions; keep jobs running' },
  { command: 'help', description: 'Show instructions' },
  { command: 'start', description: 'Open bot help and navigation' },
]);

export interface Navigation {
  action: 'sessions' | 'select' | 'output' | 'help' | 'kinds' | 'projects' | 'notifications' | 'cancel' | 'picker';
  id?: string; offset?: number; kind?: 'shell' | 'codex'; command?: SessionCommand;
}
type NavigationCandidate = { action: string; id?: string; offset?: number; kind?: string; confirmed?: boolean; command?: string };
const page = (value: string | undefined) => value !== undefined && /^(0|[1-9]\d{0,2})$/.test(value) && Number(value) <= 175 && Number(value) % 5 === 0;

// Reusable, stateless routes are deliberately limited to reading/showing menus
// (plus cancelling this message's pending actions). They confer NO terminal
// authority. The exact private owner/chat/bot checks still precede dispatch.
export function parseNavigation(data: string): Navigation | undefined {
  if (Buffer.byteLength(data) > 64) return;
  const parts = data.split(':');
  if (parts[0] !== 'n') return;
  if (parts.length === 2) {
    if (parts[1] === 'new') return { action: 'kinds' };
    if (parts[1] === 'help' || parts[1] === 'notifications' || parts[1] === 'cancel') return { action: parts[1] };
  }
  if (parts.length === 3 && parts[1] === 'sessions' && page(parts[2])) return { action: 'sessions', offset: Number(parts[2]) };
  if (parts.length === 3 && ['select', 'output'].includes(parts[1]!) && /^[a-f0-9]{32}$/.test(parts[2]!)) return { action: parts[1] as 'select' | 'output', id: parts[2] };
  if (parts.length === 4 && parts[1] === 'projects' && ['shell', 'codex'].includes(parts[2]!) && page(parts[3])) return { action: 'projects', kind: parts[2] as 'shell' | 'codex', offset: Number(parts[3]) };
  if (parts.length === 4 && parts[1] === 'picker' && sessionCommand(parts[2]!) && page(parts[3])) return { action: 'picker', command: parts[2] as SessionCommand, offset: Number(parts[3]) };
}
export function navigationData(bound: NavigationCandidate): string | undefined {
  if (bound.confirmed) return;
  let data: string | undefined;
  switch (bound.action) {
    case 'sessions': data = `n:sessions:${bound.offset || 0}`; break;
    case 'select': case 'output': data = `n:${bound.action}:${bound.id}`; break;
    case 'help': case 'notifications': case 'cancel': data = `n:${bound.action}`; break;
    case 'kinds': data = 'n:new'; break;
    case 'projects': data = `n:projects:${bound.kind}:${bound.offset || 0}`; break;
    case 'picker': data = `n:picker:${bound.command}:${bound.offset || 0}`; break;
  }
  return data && parseNavigation(data) ? data : undefined;
}
