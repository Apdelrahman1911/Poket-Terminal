type Lifecycle = 'starting' | 'running' | 'stopping' | 'stopped' | 'exited' | 'error' | 'unknown';
interface Status { state: 'starting' | 'running' | 'stopped'; lifecycle?: Lifecycle; activity?: string }
const presentations = {
  working: { tone: 'working', lifecycle: 'running', label: 'CLI: Working' },
  input: { tone: 'input', lifecycle: 'running', label: 'CLI: Awaiting input' },
  ready: { tone: 'ready', lifecycle: 'running', label: 'CLI: Ready · awaiting prompt' },
  starting: { tone: 'starting', lifecycle: 'starting', label: 'Starting · not started yet' },
  stopping: { tone: 'stopping', lifecycle: 'stopping', label: 'Stopping' },
  stopped: { tone: 'stopped', lifecycle: 'stopped', label: 'Stopped' },
  exited: { tone: 'stopped', lifecycle: 'exited', label: 'Exited' },
  error: { tone: 'error', lifecycle: 'error', label: 'Error · start/exit failed' },
  unreported: { tone: 'unreported', lifecycle: 'running', label: 'Running · activity not reported' },
  stale: { tone: 'stale', lifecycle: 'unknown', label: 'Status stale · refreshing' },
  uncertain: { tone: 'stale', lifecycle: 'unknown', label: 'State unconfirmed' },
} as const;

// Pure presentation of bounded catalog metadata: no timers, retained history, or
// guesses from process liveness/output. Lifecycle always outranks CLI activity.
export function sessionCard(status: Status, fresh: boolean) {
  if (!fresh) return presentations.stale;
  const lifecycle = status.lifecycle || status.state;
  if (lifecycle === 'error') return presentations.error;
  if (status.state === 'stopped') return lifecycle === 'exited' ? presentations.exited : presentations.stopped;
  if (lifecycle === 'stopping') return presentations.stopping;
  if (status.state === 'starting' || lifecycle === 'starting') return presentations.starting;
  if (lifecycle === 'stopped' || lifecycle === 'exited') return presentations[lifecycle];
  if (lifecycle !== 'running') return presentations.uncertain;
  if (status.activity === 'working') return presentations.working;
  if (status.activity === 'awaiting_input') return presentations.input;
  if (status.activity === 'ready') return presentations.ready;
  return presentations.unreported;
}
