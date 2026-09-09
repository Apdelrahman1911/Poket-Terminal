#!/usr/bin/env python3
"""Disposable fixed-rate UTF-8/ANSI workload, never used by the production service."""
import argparse
import json
import os
from pathlib import Path
import time
p = argparse.ArgumentParser()
p.add_argument('--rate', type=int, default=4096)
p.add_argument('--seconds', type=float, default=1810)
p.add_argument('--stats', required=True)
a = p.parse_args()
if a.rate < 1024 or a.rate > 4 * 1024 * 1024 or not 1 <= a.seconds <= 7200:
    raise SystemExit('Invalid synthetic workload bounds')
line = '\x1b[36mPT-SOAK\x1b[0m | Unicode ✓ 界 é | bounded terminal output\r\n'.encode()
# Exact 1024-byte chunks, complete UTF-8 and escape sequences, with newline padding.
chunk = line * (1024 // len(line))
chunk += b'.' * (1022 - len(chunk)) + b'\r\n'
assert len(chunk) == 1024
start = time.monotonic()
written = ticks = 0
next_report = start
stats = Path(a.stats)
def report(value):
    temporary = Path(str(stats) + '.tmp')
    temporary.write_text(json.dumps(value))
    temporary.chmod(0o600)
    temporary.replace(stats)
while time.monotonic() - start < a.seconds:
    now = time.monotonic()
    target = start + ticks * (1024 / a.rate)
    if now < target:
        time.sleep(target - now)
    view = memoryview(chunk)
    while view:
        n = os.write(1, view)
        view = view[n:]
        written += n
    ticks += 1
    if time.monotonic() >= next_report:
        report({'pid': os.getpid(), 'rateBytesPerSecond': a.rate, 'elapsedSeconds': time.monotonic() - start, 'bytesWritten': written, 'done': False})
        next_report = time.monotonic() + 5
report({'pid': os.getpid(), 'rateBytesPerSecond': a.rate, 'elapsedSeconds': time.monotonic() - start, 'bytesWritten': written, 'done': True})
