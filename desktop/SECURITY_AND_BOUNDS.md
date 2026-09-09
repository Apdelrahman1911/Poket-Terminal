# Security, persistence and bounds

## Trust boundaries

The only remote path is the existing authenticated PocketTerminal HTTPS origin.
One upgrade dispatcher retains terminal routing and adds `/api/desktop/socket`.
Only safe login HTML is public; JS/assets and native starts require existing owner authentication; WS also
requires exact Host/Origin and CSRF subprotocol. No bearer URL/localStorage,
arbitrary path/command/target, unauthenticated websockify, new password DB or CORS
exception. The desktop has no root keys, sudo or access through `/root` (0700).

TigerVNC 1.13.1 runs non-root on `:71` at 1280×720×24, capped at 15 fps, without
TCP RFB (`-rfbport -1`) or TCP X11 (`-nolisten tcp`). RFB is 0600 inside the
0700 desktop-owned runtime. Internal `SecurityTypes=None` is permitted only
behind these private Unix permissions plus the authenticated gateway. X11 still
requires a fresh private Xauthority cookie; no `-ac`/`xhost +`. Cookies never enter
argv, environment, logs or reports. Native output is discarded; service logs
contain fixed lifecycle events only.

**Root-to-Unix boundary:** a pre-connect pathname check is insufficient because
the runtime belongs to the desktop user. The gateway opens the fixed socket with
Linux `O_PATH|O_NOFOLLOW`, fstats socket type/expected non-root UID/0600, and
connects via `/proc/self/fd/<fd>`. It retains that descriptor until detach.
A rename/symlink swap cannot redirect it to another privileged listener. The
isolated swap/canary test passes on the tested Linux platform; symlinks/non-sockets are rejected.

The service is independent of Node. Dedicated-account private tmux + flock and
a foreground subreaper prevent duplicate sessions and reap owned descendants.
Cleanup uses process identities/pidfds, never a process-name or all-tmux kill.
Clean fixed environment and XFCE startup configuration exclude arbitrary session
restore. No inactive shutdown. Explicit stop ends GUI apps; restart/reboot cannot
preserve a crashed X server's apps. Provisioning and web activation are separate explicit operator actions.

## Enforced limits

Limits below are per connection unless specified. MiB/KiB are binary. These are
application queue/allocation budgets, **not** a claim that total JS/browser/native
RSS or transient allocation/GC overhead equals their sum.

| Layer | Bound / behavior |
|---|---|
| Gateway clients | 2 total, including retiring sockets; 1 per auth session; no displacement |
| WS input | 16 KiB/frame; 256 messages/s; no per-message deflate |
| RFB input | 24 KiB pending parse, 64 KiB/s input, 1024 operations/s, 64 encodings; 2 s partial/write stall |
| Protocol | RFB 3.8, None, shared; allowed bounded input operations only; 1280×720 max requests; arbitrary resize refused |
| Clipboard | 4096 bytes, manual Latin-1 browser→desktop only; compressed/extended and server→browser refused |
| Native transport | Fixed 64 KiB read buffer/chunk; 64 KiB queued writes |
| WS output / credit | 256 KiB transport, 512 KiB unacknowledged credit; pause at 256 KiB credit or 128 KiB transport; resume below 128/64 KiB |
| Connection time | 2 s native connect, 8 s handshake, 5 s missing ACK; ping 10 s, dead 30 s |
| Gateway cleanup | One 250 ms sweep; terminating socket 250 ms deadline plus sweep scheduling; root pinned fd closed on detach |
| Native start | One fixed helper, zero queued starts, 2 s rate window, 4 KiB helper output, 22 s deadline |
| Browser transport | 64 KiB incoming chunk, 512 KiB outstanding; 16 KiB outgoing message, 64 KiB send guard |
| Browser ACK | One 16 ms timer; ACK after bounded parsing and render readiness; 2 s render/send stall detaches |
| noVNC receive | 128 KiB initial capacity; hard 4 MiB cap, reject before copy/grow |
| noVNC send | Upstream fixed 10 KiB staging buffer, explicit 64 KiB transport guard |
| noVNC render | 128 actions and 8 MiB retained-cost budget, checked before allocation; image cost = 3× encoded bytes + decoded pixels (UTF-16 base64 allowance) |
| noVNC decoding | Raw/CopyRect/Tight only; four Tight streams, at most 4 MiB inflate output each; no H.264/WebCodecs probe/decoder |
| Framebuffers | Fixed max 1280×720; front/back canvas approximately 3.52 MiB pixels each; browser/GPU/decoded-image overhead extra |
| Browser lifecycle | 1 RFB renderer/socket per view; 1 retiring close reaction and 1 replaceable intent, never an accumulating awaiter list |
| Browser controls | One manual type job, max 128 characters/512 UTF-8 bytes, 20 ms step, 3.5 s deadline; 14 s connection attempt deadline |
| Native recovery | Up to 5 failed starts, 2/4/8/16 s backoff (30 s cap), reset after >60 s healthy; no tight loop |
| Native resources | 1024 fd / 512 NPROC (Linux real-UID threads, not just processes; no RAM reservation) rlimits; structured 64 KiB log + one rotated file (one small event may cross threshold); bounded state records |

The server's fixed-framebuffer native implementation and OS kernel buffers have
their own finite allocations; they are not JavaScript queue budgets. The changing
screen test measures actual all-process desktop RSS/PSS as well as the gateway.
There is no host-wide RAM guarantee/cgroup quota claimed from host `free`. Browser/site memory is extra; all browser/renderer/network sandboxes, site isolation and web security remain enabled.

## Disposal and foreground safety

Hide, pagehide, freeze notification, logout, navigation and disconnect abort
fetches, invalidate generation, discard pending input, clear sensitive text and
canvas, dispose noVNC decoders/display/listeners/capture/timers, and close WS.
`CloseGate` registers one reaction on the retiring browser socket and holds only
the newest connection intent. A permanently stuck native close may prevent a
reconnect until page reload, but never overlaps sockets or accumulates awaiters.
Fresh authentication precedes reconnect. No automatic error retry loop/input
replay, framebuffer/clipboard history or screenshot/transcript persistence.

Browser native close/GC scheduling and actual OS background behavior are outside
JS control. The gateway's credit/timeout bounds protect Node even if browser JS
is suspended before receiving a visibility event. See test limitations and
phone acceptance in `TEST_RESULTS.md` and `OWNER_STEPS.md`.
