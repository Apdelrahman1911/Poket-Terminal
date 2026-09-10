import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { assertValue, HttpError } from './errors.js';
const exec = promisify(execFile);
export const CODEX_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export interface CodexIdentity { panePid: number; paneStart: string; pid: number; start: string; threadId: string }
export interface CodexControl {
  inspect(panePid: number, cwd: string): Promise<CodexIdentity>;
  exit(identity: CodexIdentity, cwd: string, target: { socket: string; pane: string; sessionName: string }): Promise<void>;
}
const errors = new Set(['codex_inspection_limit', 'codex_target_changed', 'codex_not_directly_managed', 'codex_target_ambiguous',
  'codex_history_unavailable', 'codex_directory_changed', 'codex_safe_exit_unavailable', 'codex_exit_timeout', 'codex_inspection_unavailable']);
export function codexControl(root: string): CodexControl {
  const call = async (args: string[]) => {
    let output: string;
    try { output = (await exec('python3', ['-I', path.join(root, 'scripts/codex-control.py'), ...args], { timeout: 8000, maxBuffer: 4096 })).stdout; }
    catch { throw new HttpError(503, 'codex_inspection_unavailable'); }
    let result: Record<string, unknown>;
    try { result = JSON.parse(output); } catch { throw new HttpError(503, 'codex_inspection_unavailable'); }
    assertValue(result && typeof result === 'object' && !Array.isArray(result), 503, 'codex_inspection_unavailable');
    if (typeof result.error === 'string') throw new HttpError(409, errors.has(result.error) ? result.error : 'codex_inspection_unavailable');
    return result;
  };
  return {
    async inspect(panePid, cwd) {
      const result = await call(['inspect', String(panePid), cwd]);
      assertValue(result.panePid === panePid && Number.isSafeInteger(result.pid) && Number(result.pid) > 0
        && typeof result.paneStart === 'string' && /^\d{1,24}$/.test(result.paneStart)
        && typeof result.start === 'string' && /^\d{1,24}$/.test(result.start)
        && typeof result.threadId === 'string' && CODEX_THREAD_ID.test(result.threadId), 503, 'codex_inspection_unavailable');
      return result as unknown as CodexIdentity;
    },
    async exit(identity, cwd, target) {
      const result = await call(['exit', String(identity.panePid), cwd, JSON.stringify(identity), target.socket, target.pane, target.sessionName]);
      assertValue(result.exited === true, 503, 'codex_exit_uncertain');
    },
  };
}
