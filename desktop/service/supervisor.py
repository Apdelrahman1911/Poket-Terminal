#!/usr/bin/python3 -I
"""One foreground subreaper. Native children survive the web process, not this desktop."""
import ctypes
import fcntl
import json
import os
from pathlib import Path
import resource
import shutil
import signal
import socket
import stat
import struct
import subprocess
import sys
import time

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import BASE, atomic_json, environment, identity, private_runtime, processes, profile, safe_signal, same

STOP = False
LIBC = ctypes.CDLL(None, use_errno=True)


def request_stop(_sig, _frame):
    global STOP
    STOP = True


def reap():
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
            if not pid:
                return
        except ChildProcessError:
            return


def children(p):
    owned = processes(p['uid'])
    parents = {os.getpid()}
    found = []
    for _ in range(32):
        new = [i for i in owned if i['ppid'] in parents and i['pid'] not in parents]
        if not new:
            break
        found.extend(new)
        parents.update(i['pid'] for i in new)
    return found


def cleanup(p):
    for sig, seconds in [(signal.SIGTERM, 3), (signal.SIGKILL, 2)]:
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            reap()
            owned = children(p)
            if not owned:
                return
            for record in owned:
                safe_signal(record, sig)
            time.sleep(.05)
    if children(p):
        raise RuntimeError('child_reaping_timeout')


def log(p, event, **fields):
    file = Path(p['run']) / 'service.log'
    if file.exists() and file.stat().st_size >= 65536:
        os.replace(file, file.with_suffix('.log.1'))
    fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as f:
        f.write(json.dumps({'time': int(time.time()), 'event': event, **fields}) + '\n')


def prepare(p):
    run = Path(p['run'])
    # Ephemeral, app-owned config/cache only. Never save/restore arbitrary apps.
    for name in ('config', 'cache'):
        d = run / name
        if d.is_symlink():
            d.unlink()
        elif d.exists():
            shutil.rmtree(d)
    shutil.copytree(BASE / 'config', run / 'config')
    (run / 'cache').mkdir(mode=0o700)
    for d in (run / 'config').rglob('*'):
        d.chmod(0o700 if d.is_dir() else 0o600)
    # Write an Xauthority record directly; the random cookie is never in argv,
    # environment, stdout or reports. Xlib finds FamilyLocal hostname/display.
    fields = [socket.gethostname().encode(), str(p['display']).encode(), b'MIT-MAGIC-COOKIE-1', os.urandom(16)]
    authority = struct.pack('!H', 256) + b''.join(struct.pack('!H', len(x)) + x for x in fields)
    fd = os.open(run / 'Xauthority', os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as f:
        f.write(authority)
    for name in ('rfb.sock', 'synthetic.json'):
        (run / name).unlink(missing_ok=True)


def child_limits():
    LIBC.prctl(1, signal.SIGTERM, 0, 0, 0)  # PR_SET_PDEATHSIG
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_NOFILE, (1024, 1024))
    # RLIMIT_NPROC counts Linux threads too; sandboxed Chromium needs headroom.
    # This is a ceiling, not preallocated RAM; retain a finite per-account bound.
    resource.setrlimit(resource.RLIMIT_NPROC, (512, 512))


def launch(argv, p, env=None):
    return subprocess.Popen(argv, env=env or environment(p), cwd=p['home'], stdin=subprocess.DEVNULL,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            start_new_session=True, preexec_fn=child_limits)


def wait_native(p, x):
    end = time.monotonic() + 8
    while not STOP and time.monotonic() < end:
        if x.poll() is not None:
            raise RuntimeError('xserver_early_exit')
        sock = Path(p['run']) / 'rfb.sock'
        if sock.exists():
            s = sock.lstat()
            if not stat.S_ISSOCK(s.st_mode) or s.st_uid != p['uid'] or stat.S_IMODE(s.st_mode) != 0o600:
                raise RuntimeError('unsafe_rfb_socket')
            try:
                # Readiness requires both authenticated local X11 and Unix RFB.
                subprocess.run(['/usr/bin/xdpyinfo'], env=environment(p), stdin=subprocess.DEVNULL,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=1, check=True)
                return
            except (subprocess.SubprocessError, OSError):
                pass
        time.sleep(.1)
    raise RuntimeError('xserver_readiness_timeout')


def main():
    os.umask(0o077)
    p = profile(sys.argv[1])
    if os.getuid() != p['uid'] or os.getuid() == 0 or os.getgroups():
        raise RuntimeError('must_be_unprivileged_without_supplementary_groups')
    private_runtime(p)
    fd = os.open(Path(p['run']) / 'service.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return
    if LIBC.prctl(36, 1, 0, 0, 0):  # PR_SET_CHILD_SUBREAPER
        raise RuntimeError('subreaper_required')
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, request_stop)
    me = identity(os.getpid())
    state = Path(p['run']) / 'state.json'
    failures = 0
    try:
        while not STOP:
            atomic_json(state, {'state': 'starting', 'supervisor': me})
            began = time.monotonic()
            try:
                prepare(p)
                argv = ['/usr/bin/Xtigervnc', ':' + str(p['display']), '-geometry', '1280x720', '-depth', '24',
                        '-auth', p['run'] + '/Xauthority', '-nolisten', 'tcp', '-rfbport', '-1',
                        '-rfbunixpath', p['run'] + '/rfb.sock', '-rfbunixmode', '0600',
                        '-SecurityTypes', 'None', '-AlwaysShared', '-DisconnectClients=0',
                        '-AcceptSetDesktopSize=0', '-FrameRate', '15', '-MaxCutText', '4096',
                        '-SendCutText=0', '-SendPrimary=0', '-SetPrimary=0', '-AcceptCutText=1',
                        '-IdleTimeout', '0', '-MaxDisconnectionTime', '0', '-MaxConnectionTime', '0',
                        '-desktop', 'PocketDesktop', '-pn', '-extension', 'MIT-SHM']
                x = launch(argv, p)
                wait_native(p, x)
                session = launch(['/usr/bin/dbus-run-session', '--', '/usr/bin/xfce4-session'], p)
                if p['name'] == 'test':
                    launch(['/usr/bin/python3', '-I', str(BASE / 'synthetic.py')], p)
                time.sleep(.7)
                if session.poll() is not None or x.poll() is not None:
                    raise RuntimeError('session_early_exit')
                atomic_json(state, {'state': 'running', 'supervisor': me, 'xserver': identity(x.pid), 'session': identity(session.pid)})
                log(p, 'ready', xpid=x.pid, sessionPid=session.pid)
                while not STOP and x.poll() is None and session.poll() is None:
                    # Do not waitpid direct Popen children before poll(); reap only
                    # adopted orphans individually so returncodes remain accurate.
                    direct = {x.pid, session.pid}
                    for i in children(p):
                        if i['ppid'] == os.getpid() and i['pid'] not in direct and i['state'] == 'Z':
                            try:
                                os.waitpid(i['pid'], os.WNOHANG)
                            except ChildProcessError:
                                pass
                    time.sleep(.2)
                log(p, 'desktop_exit')
            except Exception:
                log(p, 'native_start_or_runtime_failure')
            finally:
                cleanup(p)
                (Path(p['run']) / 'rfb.sock').unlink(missing_ok=True)
                (Path(p['run']) / 'Xauthority').unlink(missing_ok=True)
            if time.monotonic() - began > 60:
                failures = 0
            failures += 1
            if STOP:
                break
            if failures >= 5:
                log(p, 'restart_budget_exhausted')
                break
            atomic_json(state, {'state': 'backoff', 'supervisor': me})
            delay = min(30, 2 ** failures)
            log(p, 'restart_backoff', seconds=delay)
            end = time.monotonic() + delay
            while not STOP and time.monotonic() < end:
                time.sleep(.1)
    finally:
        cleanup(p)
        atomic_json(state, {'state': 'stopped'})
        log(p, 'stopped')
        os.close(fd)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # No native output/cookies/window titles enter tmux history or log files.
        sys.exit(1)
