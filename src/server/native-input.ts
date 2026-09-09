import { spawn } from 'node:child_process';
import { Sessions } from './sessions.js';
import { assertValue, HttpError } from './errors.js';
import { LIMITS } from './config.js';

export interface InputTarget { sessionId: string; pane: string; window: string; pid: string }
export type NativeKey = 'Enter' | 'Escape' | 'Tab' | 'Up' | 'Down' | 'Left' | 'Right' | 'C-c';
export const NATIVE_KEYS: readonly NativeKey[] = ['Enter', 'Escape', 'Tab', 'Up', 'Down', 'Left', 'Right', 'C-c'];
export type NativeAction = { kind: 'text' | 'prompt'; text: string } | { kind: 'key'; key: NativeKey } | { kind: 'exit_history' };
export type NativeRunner = (args: string[], input?: Buffer, signal?: AbortSignal) => Promise<string>;
const BUFFER = 'pocketterminal_telegram_input_v1';
const and = (a: string, b: string) => `#{&&:${a},${b}}`;
const equal = (key: string, value: string) => `#{==:#{${key}},${value}}`;

// One on-demand tmux command child, finite stdin/stdout/stderr, no PTY, shell,
// transcript, input argv or retry. Cancellation kills ONLY that command child.
export function nativeRunner(sessions: Sessions): NativeRunner {
  return (args, input, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new HttpError(409, 'control_changed_no_replay'));
    const child = spawn('tmux', ['-L', sessions.config.tmuxSocket, ...args], {
      env: { ...process.env, TMUX: '', LC_ALL: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = Buffer.allocUnsafe(4096), stderr = Buffer.allocUnsafe(2048);
    let used = 0, errors = 0, failed = false;
    const abort = () => { failed = true; child.stdin.destroy(); child.kill('SIGKILL'); };
    const timer = setTimeout(abort, 1500); timer.unref();
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', () => { failed = true; });
    child.stdin.on('error', () => { failed = true; });
    child.stdout.on('data', (data: Buffer) => { if (used + data.length > stdout.length) return abort(); data.copy(stdout, used); used += data.length; });
    child.stderr.on('data', (data: Buffer) => { if (errors + data.length > stderr.length) return abort(); data.copy(stderr, errors); errors += data.length; });
    child.once('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (code !== 0 || failed) {
        // Only a fixed enum escapes; never tmux error text, targets or input.
        const missingBuffer = !failed && /unknown buffer|no buffer|can't find buffer|no server running|No such file/.test(stderr.subarray(0, errors).toString());
        reject(new HttpError(503, missingBuffer ? 'native_buffer_absent' : 'native_input_uncertain_no_replay'));
      } else resolve(stdout.subarray(0, used).toString());
    });
    child.stdin.end(input);
  });
}

export class NativeInput {
  private run: NativeRunner;
  private active = 0;
  private bytes = 0;
  private bufferOwned = false;
  constructor(private sessions: Sessions, runner?: NativeRunner) { this.run = runner || nativeRunner(sessions); }
  async target(id: string, signal?: AbortSignal): Promise<InputTarget> {
    const row = this.sessions.inputReady(id);
    const result = (await this.run(['display-message', '-p', '-t', `=${row.tmux_name}:`, '#{session_name}\t#{window_id}\t#{pane_id}\t#{pane_pid}\t#{pane_dead}'], undefined, signal)).trim().split('\t');
    this.sessions.inputReady(id);
    const [name, window, pane, pid, dead] = result;
    assertValue(result.length === 5 && name === row.tmux_name && /^@\d+$/.test(window || '') && /^%\d+$/.test(pane || '') && /^[1-9]\d{0,9}$/.test(pid || '') && dead === '0', 409, 'target_unavailable');
    return { sessionId: id, window: window!, pane: pane!, pid: pid! };
  }
  private condition(target: InputTarget, allowHistory: boolean) {
    assertValue(/^[a-f0-9]{32}$/.test(target.sessionId) && /^%\d+$/.test(target.pane) && /^@\d+$/.test(target.window) && /^[1-9]\d{0,9}$/.test(target.pid), 400, 'invalid_target');
    const parts = [equal('session_name', 'pt_' + target.sessionId), equal('pane_id', target.pane), equal('window_id', target.window), equal('pane_pid', target.pid), '#{pane_active}', '#{window_active}', equal('pane_dead', '0')];
    if (!allowHistory) parts.push(equal('pane_in_mode', '0'));
    return parts.reduce(and);
  }
  private async guarded(target: InputTarget, command: string, signal: AbortSignal, allowHistory = false) {
    // -F is a tmux format conditional, NOT a shell. All interpolated fragments
    // are validated native IDs or fixed commands; user text never enters argv.
    const output = await this.run(['if-shell', '-F', '-t', `=pt_${target.sessionId}:`, this.condition(target, allowHistory), command + ' ; display-message -p PT_INPUT_OK', 'display-message -p PT_TARGET_CHANGED'], undefined, signal);
    assertValue(output.trim() === 'PT_INPUT_OK', 409, 'target_changed_or_in_history');
  }
  async perform(target: InputTarget, action: NativeAction, guard: () => void, signal: AbortSignal) {
    assertValue(this.active === 0, 429, 'telegram_input_busy'); this.active++;
    let input: Buffer | undefined;
    try {
      guard(); this.sessions.inputReady(target.sessionId);
      if (action.kind === 'text' || action.kind === 'prompt') {
        // Character check first: don't allocate another oversized UTF-8 copy.
        assertValue(typeof action.text === 'string' && action.text.length > 0 && action.text.length <= LIMITS.input && Buffer.byteLength(action.text) <= LIMITS.input && !/[\x00-\x08\x0b-\x1f\x7f]/.test(action.text), 400, 'invalid_telegram_text');
        input = Buffer.from(action.text); this.bytes = input.length;
        this.bufferOwned = true;
        // Exactly one fixed app-reserved transient buffer, even after a crash.
        // load replaces it; delete consumes it. No leftover is ever replayed.
        await this.run(['load-buffer', '-b', BUFFER, '-'], input, signal);
        guard();
        await this.guarded(target, `paste-buffer -d -p -r -b ${BUFFER} -t ${target.pane}`, signal);
        if (action.kind === 'prompt') { guard(); await this.guarded(target, `send-keys -t ${target.pane} Enter`, signal); }
      } else if (action.kind === 'key') {
        assertValue(NATIVE_KEYS.includes(action.key), 400, 'invalid_key');
        await this.guarded(target, `send-keys -t ${target.pane} ${action.key}`, signal);
      } else {
        // Copy-mode cancel only. If already live tmux errors; NEVER inject q/Esc.
        await this.guarded(target, `if-shell -F -t ${target.pane} '#{pane_in_mode}' 'send-keys -X -t ${target.pane} cancel' ''`, signal, true);
      }
    } finally {
      input?.fill(0); this.bytes = 0;
      try { await this.clear(); } finally { this.active--; }
    }
  }
  async clear(force = false) {
    if (!this.bufferOwned && !force) return;
    try { await this.run(['delete-buffer', '-b', BUFFER]); this.bufferOwned = false; }
    catch (error) {
      if (error instanceof HttpError && error.code === 'native_buffer_absent') this.bufferOwned = false;
      else throw new HttpError(503, 'native_cleanup_uncertain_no_replay');
    }
  }
  stats() { return { operations: this.active, inputBytes: this.bytes, transientBuffers: this.bufferOwned ? 1 : 0 }; }
}
