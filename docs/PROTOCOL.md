# API and terminal protocol v1

All non-health requests use the configured exact HTTPS Host. Browser Origin, when present, must exactly match; state changes and WS upgrades require it. Forwarded headers are not trusted. Production uses the exact canonical HTTPS `PT_ORIGIN` (no wildcard/path/query); test mode permits only isolated app-owned state, `pt-test-*` sockets and loopback HTTPS.

| Endpoint | Behavior |
|---|---|
| `GET /health` | `{ok:true}` only; no status, versions, metrics or job data |
| `GET /api/auth` | Authentication/setup status; authenticated responses include CSRF and expiry |
| `POST /api/login` | JSON `{password}`; throttled, two concurrent Argon2 verifications, no KDF queue |
| `POST /api/logout` | Authenticated JSON `{}` with `X-CSRF-Token`; revokes socket access, not jobs |
| `GET /api/projects` | Up to 100 existing direct project directories; authenticated |
| `GET /api/sessions?limit=100&offset=0` | Authenticated catalog, at most 100 per page / 200 total retained metadata |
| `POST /api/sessions` | Auth+CSRF; `{kind?:"codex"|"shell",cwd?:string,label?:string}`; default Codex/PocketAgent |
| `PATCH /api/sessions/:id` | Auth+CSRF; `{label}` (80 Unicode characters / 320 UTF-8 bytes max) |
| `POST /api/sessions/:id/stop` | Auth+CSRF; `{confirm:id}`; kills only exact managed tmux target |
| `POST /api/sessions/:id/restart-codex` | Auth+CSRF; exact `{confirm:id,expectedUpdatedAt:number}`; confirmed exit and exact-UUID resume of a directly managed Codex session, or explicit resume of a linked stopped entry. One operation globally; no force-kill, guessed history, prompt replay or automatic retry. See [bounds/recovery](codex-restart.md). |
| `DELETE /api/sessions/:id` | Auth+CSRF; exact `{confirm:id}`; removes only a stopped metadata entry after proving its tmux session absent. Busy/existing/uncertain state refuses deletion; project files and Codex history are kept. |

Scrolling uses tmux's bounded history, not a duplicate browser transcript: wheel/trackpad and one-finger vertical swipes send native mouse reports through the existing controller/input/ACK limits. Each attachment enables mouse routing only for its managed session, including sessions predating the update. Mouse-aware TUIs receive native wheel reports; other panes enter tmux copy-mode. There is no guessed-arrow fallback when mouse reporting is unavailable, and sticky toolbar modifiers do not alter mouse packets. Shift+drag selects text. **Exit history** sends controller-only `{type:"exit_history"}` and runs tmux `send-keys -X cancel` against the active pane; it never types q/Escape into a shell/TUI. It does not reset an application's own internal scroll position. Exit operations have no pending queue, at most one per session/32 globally, and use the existing five-second tmux command timeout.
| `WSS /api/terminal/:id` | Cookie authentication plus exact Origin and subprotocols `pocketterminal.v1`, `csrf.<token>` |

Cookie: `__Host-pocketterminal`, Secure, HttpOnly, SameSite=Strict, host-only, Path=/, 12 hours. Random 256-bit opaque tokens; only SHA-256 hashes stored in SQLite. CSRF is a domain-separated digest derived from the HttpOnly cookie and returned only through authenticated same-origin API access. No bearer token in a URL/localStorage. `sessionStorage` stores only the selected public session identifier.

## WebSocket framing

- Server output: binary UTF-8 terminal bytes, frames at most 8 KiB. No JSON/base64 copies, transcript arrays or app replay backlog.
- Client ACK: `{"type":"ack","bytes":cumulativeConsumedBytes}` **after xterm.write callback**, not on network receive. Monotonic safe integer, never beyond sent bytes. Only cumulative counters are retained, not per-frame promises/ACK arrays.
- Client input: `{"type":"input","data":"..."}` <=4 KiB UTF-8; one unacknowledged input frame. Server replies `{"type":"input_ack"}` after writing it to the nonblocking PTY fd. Browser paste/pending input <=16 KiB; server accepts <=32 KiB/s and one <=4 KiB pending frame. Linux `fs.writeSync` + at most one bounded retry timer avoids node-pty's otherwise unbounded CustomWriteStream queue. Stalled PTY writes detach after 250 ms; the separate frontend network-ACK deadline is a fixed **5 s**, matching the output-consumption budget. The old 2 s deadline falsely rejected an already-written command under a simulated 2.3 s round trip. Output/control progress does not renew the input deadline. Automatic xterm query replies use the same bounded input path. No input replay on reconnect; a timeout never proves that a command did not execute.
- Client resize: `{"type":"resize","cols":2..240,"rows":2..100}`. Controller only changes tmux window dimensions; viewers resize their own attach TTY but use tmux `ignore-size`. Resize jobs are coalesced/serialized per session, never chained without bound. The current active tmux window is targeted (not hard-coded window 0); its controller size becomes the session default for newly created windows.
- Client control: `{"type":"take_control"}`. Server broadcasts `{"type":"control","controller":boolean,"connectionId":...}`. First viewer becomes controller; explicit takeover replaces it; oldest remaining viewer is promoted when controller leaves. SSH attaches directly outside browser/Telegram arbitration.
- Server errors/control are small JSON frames. Invalid frames, fake ACKs, rates, dimensions or control abuse cause attachment teardown, not job death. Inbound messages <=16 KiB; <=256 messages/s. `perMessageDeflate=false`.

## Output-credit and lifecycle limits

128 KiB maximum unacknowledged output per attachment; pause the PTY read stream at 64 KiB, resume at <=32 KiB. ACK inactivity >5 s tears down the attachment. Any overflow terminates the attachment with a visible explanation; it does not silently slice an ANSI sequence and continue. Socket transport ceiling 256 KiB, bounded small control frames. At most 32 native attachments globally, **including retiring children until actual native exit/FD closure**, as well as a 32-connection cap. Node's raw read chunk and OS/TCP/PTY/tmux tty buffers are separate bounded native layers; the stress measurements include tmux and child processes, not only JS heap.

Logical detach first unsubscribes application output, clears input/auth state, **resumes** the node-pty read stream and sends SIGHUP to **only that tmux attach-client PID**. A paused client can otherwise block flushing terminal output indefinitely. Native ownership and its exit subscription remain until node-pty's `onExit` (which follows child reaping and stream closure on the pinned Linux implementation); only then is it counted disposed. The single one-second sweep escalates retiring clients to SIGKILL after a one-second grace (normally within two seconds of detach). Idempotent shutdown uses a 250 ms HUP grace, attachment-only SIGKILL, and a two-second native-exit deadline; it fails explicitly rather than claiming cleanup if a native child remains. No signal is sent to the tmux server, pane process or persistent job. Repeated paused clients, a SIGSTOPed attachment, cap occupancy during retirement, and shutdown are tested against actual `/proc` children, ptmx fds, ReadStreams and unchanged live pane PIDs—not just logical counters.

On visibility-hidden, pagehide or freeze: close WS, release PTY, dispose xterm/FitAddon/listeners/ResizeObserver/rAF/input queue/timers. One renderer for the selected visible session, zero for the other 19 and zero in the background. Resume uses guarded recreation; no retry/poll loops or hidden-session timers. Clipboard completion is tied to the initiating terminal, globally single-flight, and discarded after disposal/switch. Auth fetches use abort signals and generation checks. No automatic reconnect loop; explicit reconnect redraws from tmux's current state.

A single backend sweep handles auth expiry/reset, idle ACK timeouts and heartbeat cleanup. An independent 30-second reconciliation timer inspects only the dedicated tmux socket. Both timers are cleared at shutdown.
