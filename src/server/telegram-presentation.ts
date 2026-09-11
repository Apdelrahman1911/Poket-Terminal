// Presentation only: bounded metadata in, no terminal output, timers or retained
// per-chat state. Lifecycle wins over activity, including stale activity flags.
export type SessionFilter = 'all' | 'input' | 'working' | 'ready' | 'stopped' | 'error' | 'other';
export const SESSION_FILTERS: readonly SessionFilter[] = ['all', 'input', 'working', 'ready', 'stopped', 'error', 'other'];
export const isSessionFilter = (value: string): value is SessionFilter => SESSION_FILTERS.includes(value as SessionFilter);
export const CATALOG_LIMIT = 180;
export const SESSION_PAGE_SIZE = 5;
export interface StatusDescription { lifecycle: string; activity: string }

const views = {
  input: { filter: 'input', rank: 0, heading: '🟡 NEEDS YOUR INPUT', short: '🟡 Input needed', label: '🟡 Input needed', detail: 'The CLI reports that input or an action is required.' },
  error: { filter: 'error', rank: 1, heading: '🔴 ERROR', short: '🔴 Error', label: '🔴 Error (verified start/exit failure)', detail: 'Verified start/exit failure. This is not a guess from terminal output.' },
  working: { filter: 'working', rank: 2, heading: '🔵 WORKING', short: '🔵 Working', label: '🔵 Working', detail: 'The CLI reports that it is actively working.' },
  ready: { filter: 'ready', rank: 3, heading: '🟢 READY / AWAITING PROMPT', short: '🟢 Ready', label: '🟢 Ready for input (not a success claim)', detail: 'The session is still running and ready for your next prompt; not a success claim.' },
  starting: { filter: 'other', rank: 4, heading: '⚪ STARTING', short: '⚪ Starting', label: '⚪ Starting · not running yet', detail: 'The session is starting or resuming; work has not been confirmed running.' },
  stopping: { filter: 'other', rank: 5, heading: '🟠 STOPPING', short: '🟠 Stopping', label: '🟠 Stopping', detail: 'Stop is in progress; the session is not confirmed stopped yet.' },
  unknown: { filter: 'other', rank: 6, heading: '❔ STATUS UNCONFIRMED', short: '❔ Unconfirmed', label: '❔ Unknown lifecycle', detail: 'Session state is unconfirmed. Refresh; do not assume working or stopped.' },
  activityUnknown: { filter: 'other', rank: 7, heading: '❔ RUNNING / ACTIVITY UNKNOWN', short: '❔ Unknown activity', label: '❔ Running · activity unknown', detail: 'The session is running, but its activity is unknown. Not a stopped or finished state.' },
  unreported: { filter: 'other', rank: 7, heading: '❔ RUNNING / ACTIVITY UNKNOWN', short: '❔ Unknown activity', label: '❔ Running · activity not reported', detail: 'The session is running, but activity is not reported. Not a stopped or finished state.' },
  stopped: { filter: 'stopped', rank: 8, heading: '⚫ STOPPED / EXITED', short: '⚫ Stopped', label: '⚫ Stopped', detail: 'The session is no longer running.' },
  exited: { filter: 'stopped', rank: 8, heading: '⚫ STOPPED / EXITED', short: '⚫ Exited', label: '⚫ Exited', detail: 'The process exited. This does not prove the task succeeded.' },
} as const;
export type SessionView = typeof views[keyof typeof views];
export function telegramSessionView(description: StatusDescription): SessionView {
  switch (description.lifecycle) {
    case 'starting': return views.starting;
    case 'stopping': return views.stopping;
    case 'stopped': return views.stopped;
    case 'exited': return views.exited;
    case 'error': return views.error;
    case 'running':
      switch (description.activity) {
        case 'working': return views.working;
        case 'awaiting_input': return views.input;
        case 'ready': return views.ready;
        case 'unknown': return views.activityUnknown;
        default: return views.unreported;
      }
    default: return views.unknown;
  }
}

// One-line labels cannot spoof a new status section. Keep plain Telegram text,
// Unicode names and bidi text, but remove direction overrides/control bytes.
export function telegramLabel(value: string, limit = 80) {
  let text = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/[\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, limit);
  if (/[\ud800-\udbff]$/.test(text)) text = text.slice(0, -1);
  return text || '(unnamed)';
}
export function telegramSessionButton(label: string, description: StatusDescription | SessionView) {
  const view = 'short' in description ? description : telegramSessionView(description);
  return `${view.short} · ${telegramLabel(label, 60 - view.short.length - 3)}`;
}
export const SESSION_LEGEND = '🟡 Needs input · 🔵 Working · 🟢 Ready (not success)\n⚫ Stopped/exited · 🔴 Error · ❔ Unknown activity';
