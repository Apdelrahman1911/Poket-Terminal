"""Fixed app-owned profiles and PID-reuse-safe local operations (no browser input)."""
import json
import os
from pathlib import Path
import pwd
import signal
import stat
import time

BASE = Path(__file__).resolve().parent
PROFILES = {
    'desktop': {'user': 'pocketdesktop', 'home': '/var/lib/pocketdesktop', 'run': '/run/pocketdesktop', 'display': 71},
    'test': {'user': 'pocketdesktop-test', 'home': '/var/lib/pocketdesktop-test', 'run': '/run/pocketdesktop-test', 'display': 72},
}


def profile(name):
    p = dict(PROFILES[name])
    account = pwd.getpwnam(p['user'])
    if account.pw_uid == 0 or account.pw_dir != p['home']:
        raise RuntimeError('unsafe_account')
    p.update(name=name, uid=account.pw_uid, gid=account.pw_gid)
    return p


def identity(pid):
    try:
        proc = Path('/proc') / str(pid)
        s = (proc / 'stat').read_text().rsplit(')', 1)[1].split()
        return {'pid': int(pid), 'ppid': int(s[1]), 'startTicks': int(s[19]), 'uid': proc.stat().st_uid, 'state': s[0]}
    except (FileNotFoundError, ProcessLookupError, PermissionError):
        return None


def same(record):
    current = identity(record['pid'])
    return current and all(current[k] == record[k] for k in ('pid', 'startTicks', 'uid'))


def processes(uid):
    result = []
    for d in Path('/proc').iterdir():
        if d.name.isdecimal():
            i = identity(int(d.name))
            if i and i['uid'] == uid:
                result.append(i)
    return result


def safe_signal(record, sig):
    """pidfd pins a process even if it exits between the identity check and signal."""
    try:
        fd = os.pidfd_open(record['pid'])
        try:
            if same(record):
                signal.pidfd_send_signal(fd, sig)
        finally:
            os.close(fd)
    except (ProcessLookupError, FileNotFoundError):
        pass


def read_json(file, max_bytes=16384):
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_size > max_bytes:
            raise RuntimeError('invalid_identity_file')
        return json.loads(os.read(fd, max_bytes + 1))
    finally:
        os.close(fd)


def atomic_json(file, value):
    file = Path(file)
    temp = file.with_name(file.name + '.new')
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(value, f, separators=(',', ':'))
        f.write('\n')
    os.replace(temp, file)


def environment(p):
    # Never inherit root's API/auth/SSH/provider environment into a desktop process.
    return {'HOME': p['home'], 'USER': p['user'], 'LOGNAME': p['user'], 'SHELL': '/bin/bash',
            'PATH': '/usr/local/bin:/usr/bin:/bin', 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8',
            'DISPLAY': ':' + str(p['display']), 'XAUTHORITY': p['run'] + '/Xauthority',
            'XDG_RUNTIME_DIR': p['run'], 'XDG_CONFIG_HOME': p['run'] + '/config',
            'XDG_CACHE_HOME': p['run'] + '/cache', 'XDG_CONFIG_DIRS': str(BASE / 'config'),
            'XDG_DATA_DIRS': '/usr/local/share:/usr/share', 'XDG_CURRENT_DESKTOP': 'XFCE',
            'XDG_SESSION_DESKTOP': 'xfce', 'NO_AT_BRIDGE': '1', 'GSETTINGS_BACKEND': 'memory'}


def private_runtime(p):
    s = Path(p['run']).lstat()
    if not stat.S_ISDIR(s.st_mode) or s.st_uid != p['uid'] or stat.S_IMODE(s.st_mode) != 0o700:
        raise RuntimeError('unsafe_runtime_directory')


def status(p):
    try:
        private_runtime(p)
        state = read_json(Path(p['run']) / 'state.json')
        supervisor = state.get('supervisor')
        if not supervisor or supervisor.get('uid') != p['uid'] or not same(supervisor):
            return {'state': 'stopped', 'profile': p['name']}
        x = state.get('xserver')
        sock = Path(p['run']) / 'rfb.sock'
        s = sock.lstat() if sock.exists() else None
        ready = (state.get('state') == 'running' and x and x.get('uid') == p['uid'] and same(x)
                 and s and stat.S_ISSOCK(s.st_mode) and s.st_uid == p['uid'] and stat.S_IMODE(s.st_mode) == 0o600)
        # Allowlist fields only: an unprivileged state file cannot put commands/secrets into root output.
        return {'state': 'running' if ready else 'starting', 'profile': p['name'],
                'supervisor': identity(supervisor['pid']), 'xserver': identity(x['pid']) if x and x.get('uid') == p['uid'] and same(x) else None,
                'display': ':' + str(p['display']), 'rfbSocket': str(sock)}
    except (FileNotFoundError, ValueError, KeyError, TypeError, RuntimeError):
        return {'state': 'stopped', 'profile': p['name']}
