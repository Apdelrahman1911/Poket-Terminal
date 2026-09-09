#!/usr/bin/python3 -I
"""ISOLATED TEST PROFILE ONLY: moving pixels and counters, never owner screen data."""
import json
import os
from pathlib import Path
import random
import select
import time
from Xlib import X, XK, display

d = display.Display()
screen = d.screen()
win = screen.root.create_window(0, 40, 1280, 660, 0, screen.root_depth, X.InputOutput, X.CopyFromParent,
                               background_pixel=0x152335, event_mask=X.KeyPressMask | X.ButtonPressMask | X.ExposureMask)
win.set_wm_name('PocketDesktop isolated synthetic fixture')
win.map()
gc = win.create_gc(foreground=0xffffff)
count = {'frames': 0, 'keys': 0, 'clicks': 0, 'aKeys': 0, 'pid': os.getpid()}
output = Path(os.environ['XDG_RUNTIME_DIR']) / 'synthetic.json'
next_write = 0
while True:
    while d.pending_events():
        e = d.next_event()
        if e.type == X.KeyPress:
            count['keys'] += 1
            if d.keycode_to_keysym(e.detail, 0) == XK.string_to_keysym('a'):
                count['aKeys'] += 1
        elif e.type == X.ButtonPress:
            count['clicks'] += 1
            win.set_input_focus(X.RevertToParent, X.CurrentTime)
    count['frames'] += 1
    for n in range(30):
        gc.change(foreground=random.randrange(0xffffff))
        win.fill_rectangle(gc, (count['frames'] * 13 + n * 41) % 1180, (n * 31) % 550, 100, 70)
    gc.change(foreground=0xffffff)
    win.draw_text(gc, 28, 25, b'ISOLATED TEST: click and type. No owner applications or data.')
    d.flush()
    if time.monotonic() >= next_write:
        temp = output.with_suffix('.new')
        temp.write_text(json.dumps(count))
        os.replace(temp, output)
        next_write = time.monotonic() + .5
    select.select([d.fileno()], [], [], 1 / 12)
