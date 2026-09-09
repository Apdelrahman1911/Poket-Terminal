#!/usr/bin/python3 -I
"""Root-only CLI. Fixed service, private tmux; no arbitrary commands or targets."""
import fcntl
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import time

# -I intentionally excludes cwd/user PYTHONPATH; helpers are root-owned read-only.
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import BASE, atomic_json, environment, private_runtime, processes, profile, safe_signal, status

CONTROL = Path('/run/pocketdesktop-control')


def stop(p):
    current = status(p)
    if current.get('supervisor'):
        safe_signal(current['supervisor'], signal.SIGTERM)
        end = time.monotonic() + 8
        while time.monotonic() < end and status(p)['state'] != 'stopped':
            time.sleep(.1)
    # Dedicated app-owned UID only, never a tmux glob/process-name match. Also reaps
    # orphan desktop children after supervisor SIGKILL. pidfd avoids PID reuse races.
    for sig, seconds in [(signal.SIGTERM, 3), (signal.SIGKILL, 2)]:
        for record in processes(p['uid']):
            safe_signal(record, sig)
        end = time.monotonic() + seconds
        while time.monotonic() < end and any(i['state'] != 'Z' for i in processes(p['uid'])):
            time.sleep(.05)
    if any(i['state'] != 'Z' for i in processes(p['uid'])):
        raise RuntimeError('owned_process_shutdown_timeout')
    return {'state': 'stopped', 'profile': p['name']}


def start(p):
    current = status(p)
    if current['state'] == 'running':
        return current
    if current['state'] == 'stopped':
        # Crash recovery is deliberately scoped to this locked account. It never
        # restores applications or shell/Codex jobs from a saved desktop session.
        if processes(p['uid']):
            stop(p)
        root = Path(p['run'])
        if not root.exists():
            root.mkdir(mode=0o700)
            os.chown(root, p['uid'], p['gid'])
        private_runtime(p)
        env = environment(p)
        # tmux -f /dev/null: no user/root hooks; env -i equivalent via explicit env.
        command = f'exec /usr/bin/python3 -I {BASE}/supervisor.py {p["name"]}'
        def drop():
            os.setgroups([])
            os.setgid(p['gid'])
            os.setuid(p['uid'])
        subprocess.run(['/usr/bin/tmux', '-S', p['run'] + '/tmux.sock', '-f', '/dev/null',
                        'new-session', '-d', '-s', 'desktop', '-x', '80', '-y', '24', command],
                       env=env, cwd=p['home'], preexec_fn=drop, check=True,
                       timeout=5, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    end = time.monotonic() + 18
    while time.monotonic() < end:
        current = status(p)
        if current['state'] == 'running':
            return current
        time.sleep(.1)
    raise RuntimeError('desktop_start_timeout')


def main():
    os.umask(0o077)
    if os.geteuid() != 0:
        raise RuntimeError('root_only_control')
    args = sys.argv[1:]
    if not args or args[0] not in ('start', 'status', 'stop', 'test-start', 'test-status', 'test-stop'):
        raise RuntimeError('usage: pocketdesktop start|status|stop --confirm-desktop-apps [test- prefix for isolated fixture]')
    command = args[0].removeprefix('test-')
    if args[1:] != (['--confirm-desktop-apps'] if command == 'stop' else []):
        raise RuntimeError('stop_ends_desktop_GUI_apps_not_PocketTerminal_jobs: require --confirm-desktop-apps')
    p = profile('test' if args[0].startswith('test-') else 'desktop')
    CONTROL.mkdir(mode=0o700, exist_ok=True)
    st = CONTROL.lstat()
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != 0 or stat.S_IMODE(st.st_mode) != 0o700:
        raise RuntimeError('unsafe_control_directory')
    # Persistent lock inode, bounded acquisition; no stale-PID lock races.
    fd = os.open(CONTROL / (p['name'] + '.lock'), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        end = time.monotonic() + 22
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() > end:
                    raise RuntimeError('control_busy')
                time.sleep(.1)
        print(json.dumps({'start': start, 'status': status, 'stop': stop}[command](p)))
    finally:
        os.close(fd)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Never emit subprocess output/environment/identity-file contents.
        print(json.dumps({'error': str(error) if isinstance(error, RuntimeError) else 'control_failed'}))
        sys.exit(1)
