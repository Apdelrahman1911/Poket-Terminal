# Optional Telegram controls (root access)

**Disabled/unpaired by default. Bot chats are not end-to-end encrypted.** Anyone
controlling the paired private Telegram account can operate root terminals. Do
not send passwords, keys or provider secrets. An outage does not stop web/jobs.

For **one bot across several VPSs**, use [Telegram fleet setup](telegram-fleet.md).
Only the controller polls Telegram; all linked VPSs notify independently of the
selected server. Do not independently pair the shared bot on each worker.

## Create a bot and install its token privately

Use Telegram's official **@BotFather** to create your own bot. Set **both**
`PT_TELEGRAM_BOT_USERNAME` (exact username, no @) and `PT_TELEGRAM_BOT_ID` (numeric
bot ID: token prefix before `:`) in `/etc/pocketterminal/env`. These are pins, not
user authentication. No token goes in that file. Pairing uses `getMe` to verify
both ID and username and refuses an existing webhook rather than deleting it.
Use a dedicated bot, not a token shared with another polling/webhook application.

In private Bash over SSH, with shell tracing off:

```bash
cd /opt/pocketterminal
set +x
set -a; source /etc/pocketterminal/env; set +a
source scripts/runtime-env.sh
umask 077
install -d -o root -g root -m 0700 .runtime .runtime/telegram
read -r -s -p 'Bot token (hidden): ' BOT_TOKEN
builtin printf '\n'
# Create only: refuses to overwrite an existing token. No token in argv/env.
(set -o noclobber; builtin printf '%s\n' "$BOT_TOKEN" > .runtime/telegram/token)
unset BOT_TOKEN
chmod 0600 .runtime/telegram/token
systemctl restart pocketterminal  # reload the configured pins; jobs preserved
npm run telegram -- pair
```

Do not run setup under shell/session recording. For rotation of an existing
token, first disable/revoke, then intentionally replace the secure file privately;
never echo a token or paste it into shell commands/Git/issues. Production token,
control, cursor and preferences live in **application-root `.runtime/telegram`**,
not `PT_DATA_DIR`. Every parent directory is owner-owned 0700, every regular
single-link file 0600, no symlinks. No real credentials are in this source tree.

## Private pairing, enable/disable and identity changes

Every CLI needs the **same env-loading block above**, in the installation root:

```bash
npm run telegram -- status
npm run telegram -- pair       # interactive private SSH TTY; new binding
npm run telegram -- disable    # abort polling/pending actions, preserve jobs
npm run telegram -- enable     # private TTY; reverify an existing binding
npm run telegram -- revoke     # disable and remove binding
```

Pair locally confirms ROOT access, issues a random five-minute code, then accepts
only the matching private human message to your verified bot. Send `/pair CODE`
in that private chat. Finally type **`BIND <numeric-user-id> <numeric-chat-id>`**
into SSH after checking it is your account. A username hint is unverified, never
proof; first `/start`, groups, forwarded/edited messages and user-supplied IDs
cannot pair. No token/code/user ID command-line arguments or remote setup bypass.

Both configured bot ID/username must match the SSH-persisted pair **even while
disabled**. Missing pins, legacy state without the bot username, an env-only bot
change, or a different token fail closed. To migrate/change bot identity:
**revoke privately → edit both pins/token → reload the private shell env and
restart the supervisor → pair again**. `enable` is not a migration shortcut.
An ordinary code upgrade must not reset or re-pair someone else's valid binding.

The CLI alone does not start polling. The backend starts one sequential poller
only when verified paired+enabled; a Linux abstract Unix lock arbitrates setup
and polling. No public bot listener or extra daemon. Startup/pairing discards
backlog; old input/confirmations cannot execute after a generation change. Safe
navigation may reopen menus, never replay old terminal input.

Emergency disable rotates a separate control generation that cursor writes
cannot overwrite. Within one second the backend cancels polling/pending input
and releases control; bounded child cleanup can take another 1.5 s. An already
committed create/input/stop may have occurred: **never blindly repeat it**. Corrupt
or unsafe state is not silently recovered/enabled. Startup removes only the
app-reserved `pocketterminal_telegram_input_v1` paste buffer on the dedicated
app tmux socket, never reading/replaying its contents or touching unrelated buffers.

## Commands and buttons

Telegram's **Menu** button beside the message field shows all commands. The backend
registers commands and the commands menu for the paired private chat only, after bot
identity verification. Setup is idempotent; transient setup failures do not stop
polling and are retried at most once/minute without another timer or queue. Reopen
the Telegram chat if its menu is cached.

`/sessions` lists five entries/page (at most20 live jobs), with honest native/lifecycle
labels. Select one for target-specific buttons. `/new` chooses Codex/shell, an existing
allowed project, then confirms creation. Session commands such as **/prompt** and
**/output** work without an ID: choose the exact target from the next message. No
mutable selected terminal is retained. Commands with the **full explicit ID** also work:

| Command | Action |
|---|---|
| `/select ID`, `/rename ID` | controls / reply with a new label |
| `/send ID`, `/paste ID` | reply with literal text; no extra Enter |
| `/prompt ID` | reply with literal text followed by Enter |
| `/enter ID`, `/esc ID`, `/tab ID` | explicit key confirmation/button |
| `/up ID`, `/down ID`, `/left ID`, `/right ID`, `/interrupt ID` | keys / Ctrl+C |
| `/output ID` | one bounded, plain-text recent preview |
| `/take ID`, `/release ID` | shared website/Telegram control |
| `/live ID` | cancel tmux history mode, never q/Esc into a live shell |
| `/stop ID`, `/delete ID` | confirm stop / stopped metadata-only removal |
| `/notifications`, `/website`, `/help`, `/cancel` | preference / URL / help / invalidate pending actions |

Reply to the **exact** two-minute bot request. Its target, pane/window/PID and control
generation are fixed; selecting another entry never retargets it. `/stop`, `/new` etc
inside that reply are literal input, not bot commands. Other text is never sent to a
terminal. Navigation/output buttons are stateless and reusable, including after a
restart; they only display current information/menus, never perform terminal input.
Input/keys/confirmations remain expiring and single-use; using Cancel invalidates
sibling confirmations. A stale/used action now automatically refreshes its target
controls (or the session list for old legacy messages), **without executing it**.
Use the newly shown buttons. Successful keys/input return fresh controls directly.
Read-only output does not consume sibling buttons. Selecting fresh target controls
invalidates old action buttons for that target, but never retargets pending replies.
Stop/delete
always confirm an exact ID; Delete removes only stopped metadata after confirmed
tmux absence, never project files, Codex history or tmux processes.

Browsers and Telegram share Bridges ownership. A browser owner requires an explicit
takeover confirmation; browser queued input/resize is discarded. Browser “Take control”
can reclaim it; an outstanding bot write is cancelled/reaped before granting control.
SSH is outside that ownership rule. Text/key input refuses tmux copy mode; Exit history
cancels copy mode only. Literal UTF-8 enters via bounded stdin + tmux bracketed paste,
never prompt argv/shell interpolation; keys are a fixed enum. Exact active pane/window
checks run inside tmux immediately before writes. Paste and final Enter are separate
commits; a failure can leave a partial prompt. A tmux acceptance receipt is not CLI
processing/task success. There is no automatic replay or side-effect retry.

## Notifications and bounds

Notifications default ON **including with an open browser**. Baselines are silent;
alerts dedupe/coalesce observed native needs-input, working→ready (“turn finished /
ready”, **not task success**), stopped/exited and verified start/exit error. Legacy
uninstrumented sessions receive lifecycle only. No raw-title/screen-text guessing,
retrofit, terminal capture or output in automatic alerts. Short transitions between
roughly3-second observations can be missed; native titles do not expose nonfatal
API/CLI errors. Notification-off continues baseline observations without delivery.

- Existing Node process/builtin HTTPS; one long poll, limit1,3s server wait;10s HTTP
  deadline (5s other API calls),64KiB response,24KiB request, no redirects/raw errors.
- Standalone: at most one API request/effect at a time. Fleet: one polling socket
  plus one bounded, serialized outgoing lane; an idle long poll does not block
  replies. Both modes retain ≥300ms poll completion delay, ≤1 private
  message/1.05s, capped exponential/429 backoff≤60s. No offline outbox or input retry.
- Durable file+directory-fsynced update cursor claimed **before** effects:
  **at-most-once**, not exactly-once. Crashes can lose an action/receipt.
- Every message/callback checks exact numeric user **and** private chat; forwarded,
  edited, anonymous, bot, group, business and stale messages are rejected. Callback
  action nonces are128 random bits, exact message/action/target bound, expiring/single-use.
  Reusable navigation has a separate strict <=64-byte parser that cannot encode
  terminal effects, ownership changes, create/stop/delete or notification toggles.
  It relies on the same verified private-owner authentication, not secret callbacks.
  Stale-action recovery reads only these navigation routes, never terminal text/labels.
- ≤64 callback records,8 replies,20 baseline IDs,20 coalesced notice enums,20 Telegram
  owners; no stored prompts/transcripts/outbox/selected-target input. Metadata-only JSON;
  no new DB schema/index/dependency. Update bodies die with one iteration.
- Input≤4096 UTF-8 bytes; one native operation and one reserved≤4KiB tmux buffer,
  no bot PTY/WS/renderer. Native command children have1.5s deadline and4/2KiB stdout/
  stderr caps. Explicit output uses existing200-line/64KiB snapshot cap, sends only
  last3000 UTF-16 units within a3500-unit plain message (no parse mode/link preview).
- Existing one-visible-xterm/WS,20cards,500/2000 history,5s no-replay ACK and all browser
  queue/security limits are preserved. No per-session watcher/capture/poll process.

## Isolated verification

`npm run test:publication` covers configuration pinning, private pairing/compiled
TTY CLI and security against a loopback fake API with synthetic IDs/token only.
No real Telegram/model request or native desktop/browser is needed. Optional
browser/smoke scripts require a separately prepared sandboxed test browser and
must run only in a disposable checkout. Real Telegram account/device acceptance
is an owner task, not implied by fake-API tests.
