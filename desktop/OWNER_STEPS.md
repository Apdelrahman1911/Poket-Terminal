# Daily desktop steps

After [explicit setup](DEPLOYMENT.md), log into the exact HTTPS terminal site and
open **Desktop**. Connect starts/attaches to the private desktop. Fit scales the
fixed 1280×720 screen; otherwise pan. Keyboard exposes Ctrl/Alt, arrows, Esc, Tab,
Backspace and Enter. Send keys is one bounded 128-character/512-byte job. Clipboard
is manual browser→desktop Latin-1 text up to 4 KiB; paste inside the GUI afterward.
No file transfer, audio, server→browser clipboard or automatic clipboard polling.

Disconnect, switching to Terminals, hiding the tab or logging out releases the
viewer, not GUI apps or owner terminal jobs. Two viewers maximum, one per auth
session, without displacing an existing viewer. After a slow connection failure,
reconnect intentionally; no old input replay. A stuck native closing browser WS
may require a page reload; the client keeps one waiter and never overlaps sockets.

Root-only `pocketdesktop status` inspects this desktop. Explicit
`pocketdesktop stop --confirm-desktop-apps` ends GUI apps only and is not routine
web maintenance. Native X failure/reboot cannot preserve GUI RAM processes.
Do not grant the GUI sudo/root-directory access. Chrome runs as the desktop user
with its default sandboxes/security intact; see the 512-thread caveat in setup.

Phone acceptance remains manual: test typing, modifiers, dragging, panning,
keyboard viewport, copy permissions, hide/return and reconnect on your device.
Headless mobile emulation and CDP freezing do not establish physical-phone RAM
or OS lifecycle behavior. Review [historical results](TEST_RESULTS.md).
