import fs from 'node:fs';
export function procMemory(pid: number) {
  try {
    const values: Record<string, number> = {};
    for (const line of fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8').split('\n')) { const match = /^(Rss|Pss|Private_Clean|Private_Dirty|Swap):\s+(\d+)/.exec(line); if (match) values[match[1]!] = Number(match[2]) * 1024; }
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    return { pid, rss: values.Rss || 0, pss: values.Pss || 0, private: (values.Private_Clean || 0) + (values.Private_Dirty || 0), swap: values.Swap || 0, highWaterRss: Number(/^VmHWM:\s+(\d+)/m.exec(status)?.[1] || 0) * 1024, startTicks: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] };
  } catch { return { pid, rss: 0, pss: 0, private: 0, swap: 0, startTicks: undefined }; }
}
export function descendants(pid: number): number[] {
  const all: { pid: number; ppid: number }[] = [];
  for (const dir of fs.readdirSync('/proc')) if (/^\d+$/.test(dir)) {
    try { const s = fs.readFileSync(`/proc/${dir}/stat`, 'utf8'); all.push({ pid: Number(dir), ppid: Number(s.slice(s.lastIndexOf(')') + 2).split(' ')[1]) }); } catch { /* exited */ }
  }
  const result = new Set([pid]); let changed = true;
  while (changed) { changed = false; for (const p of all) if (result.has(p.ppid) && !result.has(p.pid)) { result.add(p.pid); changed = true; } }
  result.delete(pid); return [...result];
}
export function sumMemory(pids: number[]) { const processes = pids.map(procMemory); return { rss: processes.reduce((n, p) => n + p.rss, 0), pss: processes.reduce((n, p) => n + p.pss, 0), processes }; }
// tmux rewrites argv/comm ("tmux: client"), so do not match the original attach-session argument.
// An app descendant executing tmux with a PTY slave on stdin is a native attachment; the app's
// ordinary query/resize/reconcile subprocesses use pipes instead. Verify against real list-clients
// PIDs in tests and retain ALL backend descendants separately in benchmark evidence as a cross-check.
export function attachmentPids(pids: number[]) {
  return pids.filter(pid => {
    try { return /\/tmux$/.test(fs.readlinkSync(`/proc/${pid}/exe`)) && /^\/dev\/pts\/\d+$/.test(fs.readlinkSync(`/proc/${pid}/fd/0`)); }
    catch { return false; }
  });
}
export function summary(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return { min: sorted[0], median: sorted[Math.floor(sorted.length / 2)], max: sorted[sorted.length - 1], first: values[0], last: values[values.length - 1] };
}
