#!/usr/bin/python3 -I
"""Only app-owned process metrics; never argv/env/window data or root owner jobs."""
import argparse
import json
from pathlib import Path
import pwd


def process(pid, allowed_uid):
    try:
        proc = Path('/proc') / str(pid)
        if proc.stat().st_uid != allowed_uid:
            return None
        data = (proc / 'stat').read_text().rsplit(')', 1)[1].split()
        values = {}
        if data[0] != 'Z':
            for line in (proc / 'smaps_rollup').read_text().splitlines():
                if line.startswith(('Rss:', 'Pss:')):
                    key, value, _ = line.split()
                    values[key[:-1].lower() + 'Bytes'] = int(value) * 1024
        return {'pid': pid, 'ppid': int(data[1]), 'startTicks': int(data[19]), 'uid': allowed_uid,
                'name': (proc / 'comm').read_text().strip(), 'state': data[0], **values}
    except (FileNotFoundError, ProcessLookupError, PermissionError):
        return None


def measure(user):
    uid = pwd.getpwnam(user).pw_uid
    if uid == 0 or user not in ('pocketdesktop', 'pocketdesktop-test', 'pocketdesktop-browser'):
        raise ValueError('Only fixed unprivileged app accounts may be measured')
    rows = [p for child in Path('/proc').iterdir() if child.name.isdecimal() and (p := process(int(child.name), uid))]
    return {'user': user, 'uid': uid, 'processes': rows, 'liveProcesses': sum(p['state'] != 'Z' for p in rows),
            'zombies': sum(p['state'] == 'Z' for p in rows), 'rssBytes': sum(p.get('rssBytes', 0) for p in rows),
            'pssBytes': sum(p.get('pssBytes', 0) for p in rows)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('profile', choices=['desktop', 'test', 'browser'])
    args = parser.parse_args()
    print(json.dumps(measure('pocketdesktop' + ('' if args.profile == 'desktop' else '-' + args.profile))))
