#!/usr/bin/python3 -I
"""Playwright executable wrapper: test Chromium is NEVER root or unsandboxed."""
import os
from pathlib import Path
import pwd
import sys

user = pwd.getpwnam('pocketdesktop-browser')
if any(arg in ('--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security') for arg in sys.argv[1:]):
    raise SystemExit('Refusing a disabled browser sandbox')
for arg in sys.argv[1:]:
    if arg.startswith('--user-data-dir='):
        directory = Path(arg.split('=', 1)[1])
        if not str(directory).startswith('/tmp/playwright_chromiumdev_profile-') or directory.resolve() != directory or not directory.is_dir():
            raise SystemExit('Unexpected browser profile path')
        os.chown(directory, user.pw_uid, user.pw_gid)
        os.chmod(directory, 0o700)
os.setgroups([])
os.setgid(user.pw_gid)
os.setuid(user.pw_uid)
os.chdir(user.pw_dir)
binary = '/opt/pocketdesktop-testing/chromium/chrome'  # operator-installed testing binary; never production Chrome
os.execve(binary, [binary, *sys.argv[1:]], {'HOME': user.pw_dir, 'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'})
