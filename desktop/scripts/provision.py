#!/usr/bin/env python3
"""Install only immutable app helpers/accounts, never live PocketTerminal artifacts."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import shutil
import stat
import subprocess

ROOT = Path(__file__).resolve().parents[1]
PACKAGES = ['tigervnc-standalone-server', 'tigervnc-common', 'xfce4-session', 'xfwm4', 'xfce4-panel',
            'xfce4-terminal', 'thunar', 'xfce4-settings', 'xfdesktop4', 'dbus-x11', 'xauth',
            'x11-xserver-utils', 'x11-utils', 'fonts-dejavu-core', 'python3-xlib']


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--packages', action='store_true', help='simulate, then install signed Ubuntu packages without recommends/upgrades')
    parser.add_argument('--client', type=Path, help='isolated built client directory to install with helpers')
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise SystemExit('Root is required to provision locked app accounts.')
    os.umask(0o077)
    if args.packages:
        result = subprocess.check_output(['apt-get', '-s', '--no-install-recommends', 'install', *PACKAGES], text=True)
        print(result)
        if '0 upgraded,' not in result or '0 to remove' not in result:
            raise SystemExit('Refusing package changes requiring upgrades/removals; inspect simulation.')
        subprocess.run(['apt-get', 'install', '-y', '--no-install-recommends', *PACKAGES], check=True,
                       env={**os.environ, 'DEBIAN_FRONTEND': 'noninteractive', 'NEEDRESTART_MODE': 'l'})
    features = subprocess.run(['/usr/bin/Xtigervnc', '-help'], capture_output=True, text=True).stderr
    for option in ('rfbunixpath', 'rfbunixmode', 'rfbport', 'FrameRate', 'AcceptSetDesktopSize', 'MaxCutText', 'SendCutText'):
        if option not in features:
            raise SystemExit('Installed native feature missing: ' + option)
    accounts = []
    for user in ('pocketdesktop', 'pocketdesktop-test', 'pocketdesktop-browser'):
        home = '/var/lib/' + user
        try:
            account = pwd.getpwnam(user)
        except KeyError:
            subprocess.run(['/usr/sbin/useradd', '--system', '--user-group', '--create-home', '--home-dir', home,
                            '--shell', '/usr/sbin/nologin', user], check=True)
            account = pwd.getpwnam(user)
        if account.pw_uid == 0 or account.pw_dir != home or account.pw_shell != '/usr/sbin/nologin':
            raise SystemExit('Unexpected pre-existing account; refusing to modify it: ' + user)
        # useradd creates a locked account; check only the public status marker,
        # never read or report its hash. Do not touch any existing owner account.
        state = subprocess.check_output(['/usr/bin/passwd', '-S', user], text=True).split()[1]
        if state != 'L':
            raise SystemExit('App account must be password-locked: ' + user)
        os.chmod(home, 0o700)
        os.chown(home, account.pw_uid, account.pw_gid)
        accounts.append({'user': user, 'uid': account.pw_uid, 'gid': account.pw_gid, 'home': home, 'locked': True})
    files = sorted(p for p in (ROOT / 'service').rglob('*') if p.is_file() and '__pycache__' not in p.parts)
    if args.client:
        files += sorted(p for p in args.client.rglob('*') if p.is_file())
    digest = hashlib.sha256()
    for p in files:
        relative = p.relative_to(ROOT / 'service') if p.is_relative_to(ROOT / 'service') else p.relative_to(args.client)
        digest.update(str(relative).encode() + b'\0' + p.read_bytes())
    release = Path('/opt/pocketdesktop/releases') / digest.hexdigest()[:20]
    release.parent.mkdir(parents=True, mode=0o755, exist_ok=True)
    Path('/opt/pocketdesktop').chmod(0o755)
    release.parent.chmod(0o755)
    if not release.exists():
        release.mkdir(mode=0o755)
        shutil.copytree(ROOT / 'service', release / 'service', ignore=shutil.ignore_patterns('__pycache__'))
        if args.client:
            shutil.copytree(args.client, release / 'client')
        for p in release.rglob('*'):
            os.chown(p, 0, 0)
            p.chmod(0o755 if p.is_dir() else 0o555 if p.name.endswith('.py') else 0o444)
    release.chmod(0o755)
    link = Path('/opt/pocketdesktop/current.new')
    link.unlink(missing_ok=True)
    link.symlink_to(release)
    os.replace(link, '/opt/pocketdesktop/current')
    executable = Path('/usr/local/bin/pocketdesktop')
    if executable.exists() and (not executable.is_symlink() or not str(executable.readlink()).startswith('/opt/pocketdesktop/')):
        raise SystemExit('Refuse to overwrite an unrelated executable.')
    executable.unlink(missing_ok=True)
    executable.symlink_to('/opt/pocketdesktop/current/service/control.py')
    print(json.dumps({'release': str(release), 'helper': str(executable), 'accounts': accounts, 'started': False}, indent=2))


if __name__ == '__main__':
    main()
