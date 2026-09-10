# One Telegram bot for multiple VPSs

PocketTerminal supports one **controller** and up to seven **workers** (eight
VPSs total). One private bot chat controls the fleet. Only the controller owns
the Telegram token and runs `getUpdates`; workers connect outbound to the
controller's existing HTTPS website. No extra public port, bot, PTY, WebSocket,
desktop, Redis or daemon is required. Standalone Telegram remains supported.

## Everyday use

- Send **`/servers`**, then select a named VPS. Its sessions open immediately.
- `/sessions`, `/new`, `/prompt`, `/output` and other commands use the selected
  VPS. Session commands still ask for an exact target when no ID is supplied.
- **Notifications arrive from ALL connected VPSs without switching.** Each
  message begins `[VPS name]`. Selection does not pause another VPS's observer.
  `/notifications` changes only the VPS whose labeled menu you are using;
  notifications default on for every newly linked worker.
- Every existing button and input reply remains bound to its original VPS and
  session, even after selecting a different server. Reply to the exact input
  request; bare text is never executed. Old unprefixed buttons belong only to
  the original controller VPS, never the newly selected worker.
- After a controller restart, select a server again for new commands. Old input
  replies may expire safely; nothing is replayed. Navigation can reopen menus.

Alerts retain the ordinary [Telegram observation semantics](telegram.md): native
needs-input, working→ready (not proof of task success), stopped/exited and verified
start/exit errors. Short transitions may be missed. There are no automatic
transcripts, screen-text guesses or stored offline alerts. Shared Telegram
rate-limiting can delay simultaneous alerts by a few seconds.

## Configure the first/controller VPS

First deploy this version and complete ordinary private Telegram pairing on
**only this VPS**. In each private root SSH shell, load the deployment's normal
environment before invoking a CLI:

```bash
cd /opt/pocketterminal
set +x
set -a; source /etc/pocketterminal/env; set +a
source scripts/runtime-env.sh
npm run fleet -- init 'VPS 1'
```

Read the ROOT access warning and type `FLEET`. Reload only the web backend using
your deployment's [job-preserving reload procedure](OPERATIONS.md#upgrade-and-rollback).
For the supplied systemd service, `systemctl restart pocketterminal` preserves
managed tmux jobs. On the existing Oblien installations use the web supervisor's
identity-checked HUP reload, not a workspace/desktop/tmux restart.

The existing owner binding, password, Codex configuration and projects remain
independent. Choosing a controller is not permission to clone its installation
state or personal credentials to other hosts.

## Add each additional VPS

On the controller (same environment-loading block):

```bash
npm run fleet -- add 'VPS 2' /root/pocketterminal-vps2-invite.json
```

The parent directory must be private/owner-owned `0700`. This creates a new
`0600`, create-only invitation file with a **unique per-VPS credential**, the
controller HTTPS origin, immutable node ID and already-verified bot/owner pins.
It does **not** contain the Telegram token, web password or CLI credentials.
The controller reads registry changes within one second without a restart.

Transfer the invitation directly over authenticated SSH/SCP to **only** the
intended VPS (use your SSH jump options if necessary). Never paste its contents
into Telegram, a report or Git. It is a long-lived bearer credential until
revoked, not an expiring pairing code. Delete transfer copies after setup.

On the new VPS, install PocketTerminal normally and load its **own** environment.
Do not configure/pair the shared Telegram bot independently or install its token.
Leave bot pins unset to inherit the invitation, or use the exact matching pins.

```bash
cd /opt/pocketterminal
set +x
set -a; source /etc/pocketterminal/env; set +a
source scripts/runtime-env.sh
chmod 600 /root/pocketterminal-vps2-invite.json
npm run fleet -- join /root/pocketterminal-vps2-invite.json
# Type FLEET after checking that this is the intended VPS/controller.
# Reload ONLY this VPS's web backend using its normal deployment procedure.
rm /root/pocketterminal-vps2-invite.json
npm run fleet -- status
```

The worker needs outbound HTTPS access to the controller. Only the controller's
ordinary public HTTPS port (normally 443) is needed; do not expose Node's private
port. Existing website authentication is unchanged. Repeat with distinct names
and invitations for VPS 3, 4, 5, etc. IDs must never be reused for a different VPS.

An already-paired/enabled independent worker is refused rather than silently
overwritten. Disable/revoke it intentionally first and verify identity pins.
Worker `telegram pair/enable` is blocked: use `fleet enable` to re-enable an
already-linked worker. Ordinary `telegram disable/revoke` remains an emergency
local stop, preserving jobs. Changing the paired owner/bot on the controller
fails closed against existing fleet pins; consciously relink for the new owner.

## Status, revocation and failures

```bash
npm run fleet -- status
# On the controller only, with the exact ID shown by status:
npm run fleet -- remove NODE_ID
```

Controller status includes a recent private, metadata-only runtime sample
(`.runtime/telegram/fleet-status.json`, sampled every 10 seconds). Stale samples
are not a connectivity claim. Removal revokes that worker's credential and
discards its pending handoff; it never stops its terminal jobs. Enroll again
with a new ID/key if replacing a VPS. Do not hand-edit IDs to retarget old buttons.

The controller is a single Telegram control point, not automatic high availability.
If it fails, Telegram controls/alerts pause for all VPSs, while each website,
tmux session and Codex job keeps running. Links reconnect with fresh transport
instances; backoff can be up to 60 seconds. An aborted in-flight RPC marks its
worker offline promptly; idle disconnects/undetected partitions use a 30-second
liveness window. Closing a completed reverse-proxy HTTP hop is not evidence that
the worker disconnected: proxies may close or reuse upstream sockets normally.

No root action or outgoing message is automatically retried. A connection failure
may lose an action or its receipt; an already-delivered action may have committed.
Inspect the exact VPS/session before repeating it. Online handoffs have at most
one bounded update per VPS and expire after five seconds; nothing is persisted
for later offline execution. Reconnecting never retargets or replays that input.

## Security and RAM acceptance

- Exactly one real Bot API poller, arbitrated by the existing Linux kernel lock.
  The controller owns the durable real update cursor; its local actor has a
  separate cursor so it cannot overwrite remote update claims.
  Actor sequence numbers are independent of Telegram's IDs, including a possible
  Telegram ID randomization after long inactivity.
- Exact numeric human/private-chat/bot checks precede all routing. No groups,
  channels, forwards, edited messages or username-based authentication.
- Workers use unique 256-bit keys over certificate-verified HTTPS. No secrets
  in URLs, logs or CLI arguments. No redirects or generic Telegram/shell proxy.
  The exact machine endpoint rejects cookies, browser Origin/Fetch Metadata,
  wrong Host, wrong-node keys and unrelated methods. It cannot authenticate
  normal browser APIs or act as a different worker.
- At most eight nodes, one request and one <=64 KiB online handoff per node;
  shared upstream queue <=9 requests, one upstream request at a time, private
  sends paced >=1.05 seconds apart. RPC request/response caps 32/96 KiB, 20-second
  deadline. One keep-alive HTTPS socket per worker, no output-retaining outbox.
- Per-node reply/callback routing metadata <=8 each, two-minute expiry. Existing
  local bot caps (64 actions, 8 replies, 20 observed IDs/notices) remain. Bodies
  die after the request. No terminal contents enter SQLite or private fleet files.
- Existing Node processes are reused; no extra idle worker process, renderer,
  terminal attachment or per-session watcher. Frontend/xterm behavior is unchanged.
  Timers/listeners/HTTP resources are cleaned on disable, disconnect and shutdown.
- SQLite schema stays v1. Fleet credentials/configuration are root-private files,
  not part of the ordinary metadata backup; back up separately as secrets.

Focused Linux verification:

```bash
umask 077
npm run build
node --expose-gc --import tsx --test --test-concurrency=1 tests/telegram-fleet.test.ts
```

This uses five isolated app instances, fake Telegram, synthetic owner credentials
and real disposable shell sessions: simultaneous notifications with no switching,
cross-VPS replies/buttons, duplicate input refusal, endpoint isolation, six worker
reconnect cycles and controller restart. It records heap/resource bounds in
`.runtime/evidence/telegram-fleet.json`. No paid inference or owner job is used.
Short synthetic measurements are not a new prolonged production memory soak or
a physical-phone test. Production rollout must separately preserve managed pane
and desktop process identities and measure both live backend RSS values.
