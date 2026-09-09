#!/usr/bin/python3 -I
"""Scoped native acceptance: only the disposable test UID/display may be crashed."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import pwd
import signal
import stat
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True
sys.path.insert(0, '/opt/pocketdesktop/current/service')
from common import identity, profile, processes, safe_signal, environment, same

p = profile('test')
evidence = {'profile': 'test', 'checks': [], 'identities': {}}


def record(name, condition):
    if not condition:
        raise AssertionError(name)
    evidence['checks'].append(name)


def control(command):
    args = ['/usr/local/bin/pocketdesktop', 'test-' + command]
    if command == 'stop':
        args.append('--confirm-desktop-apps')
    return json.loads(subprocess.check_output(args, text=True, timeout=35))


def until(fn, seconds=12):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if fn():
            return
        time.sleep(.1)
    raise AssertionError('native condition timed out')


def run_as(user, args, env):
    u = pwd.getpwnam(user)
    def drop():
        os.setgroups([])
        os.setgid(u.pw_gid)
        os.setuid(u.pw_uid)
    return subprocess.run(args, env=env, cwd=u.pw_dir, preexec_fn=drop,
                          stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)


def owner_snapshot():
    b = json.loads((ROOT / 'PREEXISTING_BASELINE.json').read_text())
    return {str(i['pid']): identity(i['pid']) for i in [*b['livePanes'], b['supervisor'], b['backend']]}


def names():
    return [Path(f'/proc/{i["pid"]}/comm').read_text().strip() for i in processes(p['uid']) if i['state'] != 'Z']


def main():
    before_owner = owner_snapshot()
    control('stop')
    with ThreadPoolExecutor(max_workers=4) as pool:
        starts = list(pool.map(lambda _: control('start'), range(4)))
    original = starts[0]
    record('four concurrent starts are one supervisor/X server', all(s['supervisor']['startTicks'] == original['supervisor']['startTicks'] and s['xserver']['pid'] == original['xserver']['pid'] for s in starts))
    until(lambda: (Path(p['run']) / 'synthetic.json').exists())
    evidence['identities']['first'] = original
    record('non-root locked private account', p['uid'] != 0 and pwd.getpwnam(p['user']).pw_shell == '/usr/sbin/nologin' and subprocess.check_output(['passwd', '-S', p['user']], text=True).split()[1] == 'L')
    record('no supplementary privileged groups', subprocess.check_output(['id', '-G', p['user']], text=True).split() == [str(p['gid'])])
    for name, mode in [('', 0o700), ('rfb.sock', 0o600), ('Xauthority', 0o600), ('state.json', 0o600), ('service.lock', 0o600)]:
        s = (Path(p['run']) / name).lstat()
        record('private permissions ' + (name or 'runtime'), s.st_uid == p['uid'] and stat.S_IMODE(s.st_mode) == mode)
    record('RFB is a Unix socket', stat.S_ISSOCK((Path(p['run']) / 'rfb.sock').lstat().st_mode))
    args = Path(f'/proc/{original["xserver"]["pid"]}/cmdline').read_bytes().split(b'\0')
    record('no X11 TCP / no access-control bypass', b'-nolisten' in args and args[args.index(b'-nolisten') + 1] == b'tcp' and b'-ac' not in args)
    record('TCP RFB disabled from initial exec', args[args.index(b'-rfbport') + 1] == b'-1')
    for flag in (b'-AcceptSetDesktopSize=0', b'-SendCutText=0', b'-SetPrimary=0', b'-SendPrimary=0'):
        record(flag.decode(), flag in args)
    ports = {int(line.split()[3].rsplit(':', 1)[1]) for line in subprocess.check_output(['ss', '-H', '-ltn'], text=True).splitlines()}
    record('no VNC/X11/noVNC TCP service', not any(5900 <= n < 6100 or n in (6080, 6081) for n in ports))
    record('valid private Xauthority works', run_as(p['user'], ['/usr/bin/xdpyinfo'], environment(p)).returncode == 0)
    record('X11 rejects missing cookie', run_as('pocketdesktop-browser', ['/usr/bin/xdpyinfo'], {'PATH': '/usr/bin:/bin', 'DISPLAY': ':72', 'XAUTHORITY': '/nonexistent'}).returncode != 0)
    record('other unprivileged account cannot read RFB or Xauthority', run_as('pocketdesktop-browser', ['/usr/bin/test', '-r', p['run'] + '/Xauthority'], {'PATH': '/usr/bin:/bin'}).returncode != 0)
    record('one X server/session/D-Bus', names().count('Xtigervnc') == names().count('xfce4-session') == names().count('dbus-daemon') == 1)
    record('direct duplicate supervisor exits without native children', run_as(p['user'], ['/usr/bin/python3', '-I', '/opt/pocketdesktop/current/service/supervisor.py', 'test'], environment(p)).returncode == 0)
    record('duplicate leaves identities unchanged', control('status')['xserver']['startTicks'] == original['xserver']['startTicks'])

    old = processes(p['uid'])
    cookie_before = hashlib.sha256((Path(p['run']) / 'Xauthority').read_bytes()).digest()
    safe_signal(original['xserver'], signal.SIGKILL)
    until(lambda: (s := control('status'))['state'] == 'running' and s['xserver']['startTicks'] != original['xserver']['startTicks'])
    recovered = control('status'); evidence['identities']['afterXCrash'] = recovered
    record('X crash keeps singleton supervisor', recovered['supervisor']['startTicks'] == original['supervisor']['startTicks'])
    record('new Xauthority on native recovery (cookie not reported)', hashlib.sha256((Path(p['run']) / 'Xauthority').read_bytes()).digest() != cookie_before)
    until(lambda: not any(same(i) for i in old if i['pid'] not in [original['supervisor']['pid'], original['supervisor']['ppid']]))
    record('X crash cleanup reaps prior GUI descendants', True)
    record('crash recovery has one X/session/D-Bus', names().count('Xtigervnc') == names().count('xfce4-session') == names().count('dbus-daemon') == 1)

    safe_signal(recovered['supervisor'], signal.SIGKILL)
    until(lambda: control('status')['state'] == 'stopped')
    recovered = control('start'); evidence['identities']['afterSupervisorCrash'] = recovered
    record('supervisor crash recovery cleans only dedicated UID orphans', names().count('Xtigervnc') == names().count('xfce4-session') == names().count('dbus-daemon') == 1)
    stopped_pids = processes(p['uid'])
    control('stop')
    until(lambda: not any(i['state'] != 'Z' for i in processes(p['uid'])))
    record('explicit scoped stop leaves no live test processes', True)
    record('all current owner panes/backend/supervisor preserved through crashes/stop', owner_snapshot() == before_owner)
    control('start')  # ready for isolated browser/measurement gates, never published
    evidence['checks'].append('test fixture restored for subsequent isolated tests')
    evidence['passed'] = True


if __name__ == '__main__':
    try:
        main()
    finally:
        out = ROOT / '.runtime/evidence/native-service.json'
        out.write_text(json.dumps(evidence, indent=2) + '\n')
        out.chmod(0o600)
    print(json.dumps(evidence, indent=2))
