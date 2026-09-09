#!/usr/bin/env python3
"""Linux foreground supervisor. No daemon, runtime dependency, shell evaluation or unbounded log buffer."""
import ctypes
import errno
import fcntl
import json
import os
from pathlib import Path
import select
import signal
import stat
import subprocess
import sys
import time

MAX_LOG = 1024 * 1024
STOP_TIMEOUT = 10.0
stopping = 0
restart = False

def on_signal(signum, _frame):
    global stopping, restart
    if signum == signal.SIGHUP:
        restart = True
    else:
        stopping = signum

class Log:
    def __init__(self, state):
        self.path = state / 'service.log'
        self.file = self.open()
    def open(self):
        fd = os.open(self.path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        os.fchmod(fd, 0o600)
        return os.fdopen(fd, 'ab', buffering=0)
    def write(self, value):
        if os.fstat(self.file.fileno()).st_size + len(value) > MAX_LOG:
            self.file.close()
            for n in (2, 1):
                source = Path(str(self.path) + (f'.{n-1}' if n > 1 else ''))
                if source.exists(): os.replace(source, Path(str(self.path) + f'.{n}'))
            self.file = self.open()
        self.file.write(value)
    def event(self, event, **fields):
        value = {'at': time.time(), 'event': event, **fields}
        self.write((json.dumps(value, separators=(',', ':')) + '\n').encode())

def main():
    global restart
    os.umask(0o077)
    if len(sys.argv) < 3:
        print('Usage: supervisor.py STATE_DIR COMMAND [ARG ...]', file=sys.stderr)
        return 64
    state = Path(sys.argv[1]).absolute()
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    st = state.lstat()
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid():
        raise RuntimeError('Unsafe state directory')
    state.chmod(0o700)
    lock = os.open(state / 'service.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as error:
        if error.errno not in (errno.EAGAIN, errno.EACCES): raise
        print('PocketTerminal already supervised; no second instance started.', flush=True)
        os.close(lock)
        return 0
    log = Log(state)
    (state / 'supervisor.pid').write_text(str(os.getpid()) + '\n')
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP): signal.signal(sig, on_signal)
    backoff = 1.0
    starts = 0
    parent = os.getpid()
    libc = ctypes.CDLL(None, use_errno=True)
    def child_setup():
        # Do not leave an unsupervised web backend if this foreground supervisor dies.
        if libc.prctl(1, signal.SIGTERM, 0, 0, 0) != 0: os._exit(70)  # PR_SET_PDEATHSIG
        if os.getppid() != parent: os._exit(70)
    try:
        while not stopping:
            started = time.monotonic()
            child = subprocess.Popen(sys.argv[2:], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT, start_new_session=True, pass_fds=(lock,), preexec_fn=child_setup)
            starts += 1
            (state / 'web.pid').write_text(str(child.pid) + '\n')
            log.event('child_start', pid=child.pid, starts=starts)
            os.set_blocking(child.stdout.fileno(), False)
            deadline = None
            requested_restart = False
            while True:
                if (stopping or restart) and deadline is None:
                    requested_restart = restart and not stopping
                    restart = False
                    try: os.killpg(child.pid, stopping or signal.SIGTERM)
                    except ProcessLookupError: pass
                    deadline = time.monotonic() + STOP_TIMEOUT
                if deadline and time.monotonic() >= deadline and child.poll() is None:
                    try: os.killpg(child.pid, signal.SIGKILL)
                    except ProcessLookupError: pass
                readable, _, _ = select.select([child.stdout], [], [], 0.1)
                if readable:
                    try: data = os.read(child.stdout.fileno(), 65536)
                    except BlockingIOError: data = b''
                    if data: log.write(data)
                result = child.poll()
                if result is not None:
                    # Drain a bounded pipe tail only; terminal bytes never enter this pipe.
                    for _ in range(16):
                        try: data = os.read(child.stdout.fileno(), 65536)
                        except BlockingIOError: break
                        if not data: break
                        log.write(data)
                    child.stdout.close()
                    log.event('child_exit', pid=child.pid, status=result, uptime=round(time.monotonic() - started, 3))
                    break
            if stopping: break
            if time.monotonic() - started >= 60: backoff = 1.0
            wait = 0 if requested_restart else backoff
            if not requested_restart: backoff = min(backoff * 2, 30.0)
            log.event('restart_wait', seconds=wait)
            until = time.monotonic() + wait
            while time.monotonic() < until and not stopping: time.sleep(max(0.0, min(0.1, until - time.monotonic())))
        log.event('supervisor_stop', signal=stopping)
        return 0
    finally:
        for name in ('web.pid', 'supervisor.pid'):
            try: (state / name).unlink()
            except FileNotFoundError: pass
        log.file.close()
        os.close(lock)

if __name__ == '__main__':
    try: sys.exit(main())
    except Exception:
        print('PocketTerminal supervisor failed; inspect app-owned state and permissions.', file=sys.stderr)
        sys.exit(70)
