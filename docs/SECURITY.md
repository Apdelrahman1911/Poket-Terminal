# Security, data integrity and bounded-memory design

## Threat model

This is a single-owner **root** terminal, not a multi-tenant sandbox. A stolen password/login or hostile code deliberately run inside a root terminal can read/change the VPS, bypass application caps, and affect other projects. The app cannot protect root from itself. Use a unique strong password and trusted devices. No signup/email/MFA or browser password-reset endpoint exists in v1.

No default/placeholder/generated production password. Hidden-input SSH CLI requires a TTY, confirmation, >=16 characters with three character classes (or >=24 with two), >=8 distinct characters and <=256 UTF-8 bytes. Argon2id v19 uses m=19456 KiB, t=2, p=1, independent random salts. Login concurrency <=2, pending KDF queue zero; bounded 128-source throttle map, five attempts/source/15 minutes and twenty global attempts/15 minutes. Successful source logins clear only the source window; the global window remains. This intentionally conservative single-owner limit may require waiting 15 minutes after repeated logins. The actual socket address is used, ignoring forged X-Forwarded-For/Forwarded. Behind an edge, users may share its throttle bucket (safe, potentially conservative availability).

Auth records <=64, expiring after 12 hours; periodic cleanup and login pruning. Raw tokens never stored in SQLite. Logout invalidates live sockets immediately; external CLI reset increments owner revision and deletes tokens, observed within one second (also checked on every frame). Jobs persist. Opaque cookies never exposed to scripts; CSRF token is not a terminal credential on its own. Exact Host/Origin, required JSON, CSRF, restrictive headers, no CORS, no embedded third-party scripts, no debug/metrics HTTP route. Upgrade authorization runs before any PTY allocation.

TLS terminates at the operator's HTTPS reverse proxy. Node defaults to loopback
127.0.0.1:3000 and does not trust forwarded Host/Origin/IP/protocol headers. There
is no plaintext-cookie mode; the proxy preserves Host/Origin, enforces HTTPS and
handles WebSocket upgrades. No public 9990, VNC or X11 listener is needed. Local
tests use private self-signed localhost certificates, not public-domain TLS proof.

`PT_ORIGIN` is the exact canonical HTTPS origin, without wildcard/path/query or
userinfo. Both clients upgrade an accidental HTTP page to HTTPS on its current
host before mounting login UI; other non-HTTPS schemes are rejected. HTTP
JavaScript can be tampered with, so proxy redirects/TLS remain mandatory. Preserve
older hashed assets when deploying a compatible client; open tabs must refresh
for the update. Never build over a running installation's dist.

## Process isolation and persistence

Dedicated tmux socket `pocketterminal`, generated `pt_<32 hex>` session identifiers. Launches use `execFile`/argument vectors; labels/cwds never become shell source. Cwds are real existing direct children of configured `PT_PROJECT_ROOT`, with control characters and escapes/symlinks outside rejected. `PT_DEFAULT_CWD` defaults to its `default` child; the project root defaults to the owner home’s `projects`. Tests use disposable fixture directories only. The only intentional shell command interpretation is authenticated terminal input typed by the owner.

Creation reserves one of twenty slots transactionally **before** async spawn; failed known spawns roll back. Unknown spawn/kill state retains reservation rather than admitting extra jobs. Reconciliation skips stale snapshots when a create/stop generation changes, adopts owned orphan jobs, and marks missing/dead jobs stopped without rerun. Only known names on the app socket are stopped. Test cleanup uses only explicitly generated `pt-test-*` servers. Unrelated tmux servers/jobs stay intact. The documented systemd unit uses `KillMode=process`; default cgroup-wide cleanup would violate this boundary.

Detached tmux owns shell/Codex, not the WebSocket or attach PTY. Each active viewer gets one attach PTY and read-only input enforcement unless controller. Inactive sessions get no Node PTY. Closing/logout/expiry/background/backend failure does not stop jobs. Ctrl+B, D detaches a tmux client. Standard tmux multi-window/pane keys are supported: reconciliation aggregates every pane and only reaps a session when no live panes remain. Stop deliberately ends all windows of that selected session. Resize targets the active window and updates the size default for newly created windows; manually switching among existing windows may require a viewport resize/Take control to apply that device’s preferred size. A reboot destroys tmux processes; metadata becomes stopped and dangerous/billable work never starts automatically. Codex history can be resumed intentionally in a new terminal.

Installed tmux 3.4 crashes if `window-size manual` is the global default before the first window. The app applies manual sizing to each newly created window instead (historically verified in an isolated fixture); it does not change unrelated tmux configuration.

## Memory limits / instrumentation boundaries

- xterm's built-in renderer, one active instance, scrollback 500 on both desktop and mobile. FitAddon only; no GPU/WebGL addon or transcript React state. Dimensions <=240×100.
- tmux app-server history limit 2000; stopped dead pane history is removed on reconciliation. Terminal catalog bounded to <=200 metadata rows; maximum 20 starting/running jobs.
- Output/input credit details in PROTOCOL.md. No terminal output in SQLite/application logs. Browser output is passed imperatively to xterm with callback ACKs; stream overflow is visible disconnect/redraw, not silent ANSI corruption.
- Slow ACKs pause attachment reads only. Teardown drops application data listeners, resumes native reads and sends attachment-only SIGHUP, with bounded SIGKILL escalation. Native ownership/cap remains until real exit/FD closure; logical disconnect alone is not disposal. Persistent jobs keep running. tmux's tty buffering is tested and measured separately under high-rate/non-ACK conditions, including real child/ptmx-fd/ReadStream cleanup checks. See PROTOCOL.md for deadlines and shutdown behavior.
- Production Node runs with `--max-old-space-size=96`; this is ordinary V8 heap sizing, not forced GC. Heap, native/external, arrayBuffers, RSS and PSS are measured separately. Jobs and PM2/Python/test-runner/browser processes are not mislabeled as backend overhead.
- Browser measurement uses Chromium/CDP and mobile **viewport emulation**, not a physical phone. Native renderer RSS/PSS is recorded when procfs exposes it. CDP counters/WS wrappers are injected only by isolated test harnesses, not installed in the production page. Backend measurements use a private parent IPC fd enabled only with isolated test-mode configuration. No network diagnostic endpoint exists.
- Foreground Python 3.12 supervisor: flock, process-group signal forwarding, 10-second stop deadline, 1/2/4/…/30-second crash backoff, parent-death signal, bounded log pipe chunks and 3×1 MiB logs, stable single-instance lock. No persistent shell or native helper process. The isolated minimal-env restart/lock/job test verifies persistence. This publication does not rerun historical memory comparisons or launch systemd.

## SQLite v1 and backups

Schema exported in `schema-v1.sql`, exact schema comparison with an in-memory reference, application ID `0x50544d31`, explicit transactional migration v1. Foreign keys on, trusted_schema off, full synchronous WAL, 100-page auto-checkpoint, journal size limit 1 MiB. Corrupt/unrecognized/modified schemas are rejected, never silently deleted/reset; failed migrations roll back schema and version. State directories mode 0700; DB/WAL/SHM/auth backups mode 0600, unsafe symlinks/hardlinks rejected. No terminal transcript columns.

Indexes correspond to measured EXPLAIN plans: primary hashed-token lookup, expiry range deletion, running-state count and ordered paginated catalog. Online SQLite backup API (not copying a live database file) provides consistent recoverable snapshots. Backups contain password hashes/auth metadata and must remain private. After an intentional restore, revoke/reset owner authentication before reconnecting a public route to avoid resurrecting old logins.

## Logging and limitations

Fastify request logging disabled; only bounded startup/lifecycle/error-category logs. Never terminal bytes, passwords, cookies/headers, provider credentials or user commands. Codex's own existing private session/history behavior is separate. JavaScript password strings/clipboard contents cannot be reliably zeroized; the app minimizes lifetime but makes no zeroization claim. A terminated attach's native buffers/objects may persist until ordinary GC; stable plateau must be measured, not assumed. Root-owned provider configuration remains entirely external.

## Phone viewport / fonts

A single page-wide rAF-coalesced visualViewport resize/scroll subscription sizes the workspace even when a phone keyboard does not shrink the layout viewport or dvh; compact controls keep the bottom key row visible. It uses CSS variables/dataset only, not output React state, and removes every listener/rAF on disposal. A keyboard-like visualViewport-only shrink regression is automated; actual iOS/Android keyboard behavior remains a physical-device gate. System monospace fonts are used, no heavy webfont. The test host lacks some CJK glyphs: DOM UTF-8/wide-cell/ANSI checks distinguish byte/rendering correctness from missing-font tofu. The New control uses ASCII '+'.
