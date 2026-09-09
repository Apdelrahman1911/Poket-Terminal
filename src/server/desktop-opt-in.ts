import fs from 'node:fs';
import path from 'node:path';

// Read once on each Node start, not once in the long-lived Python supervisor.
// Absence/unsafe/malformed opt-in disables only Desktop, never owner terminals.
export function desktopOptIn(file = '/etc/pocketdesktop/gateway.json'): { enabled: boolean; autoStart: boolean } {
  const disabled = { enabled: false, autoStart: false };
  let fd: number | undefined;
  try {
    const dir = fs.lstatSync(path.dirname(file));
    if (!dir.isDirectory() || dir.uid !== 0 || (dir.mode & 0o777) !== 0o700) return disabled;
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.uid !== 0 || (st.mode & 0o777) !== 0o600 || st.size > 256) return disabled;
    const data = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (!data || typeof data.enabled !== 'boolean' || typeof data.autoStart !== 'boolean' || Object.keys(data).some(k => !['enabled', 'autoStart'].includes(k))) return disabled;
    return { enabled: data.enabled, autoStart: data.enabled && data.autoStart };
  } catch { return disabled; } finally { if (fd !== undefined) fs.closeSync(fd); }
}
