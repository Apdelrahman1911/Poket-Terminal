# Important agent updates → Telegram

Agents can explicitly send short milestones, blockers, questions, errors and
completion summaries through the **existing paired bot** on each VPS. In a fleet,
every message receives its authenticated `[VPS name]` prefix, regardless of the
selected `/servers` entry. No extra Telegram token, bot, public port or DNS record
is needed. These are **agent-written reports**, not independent proof of success.

```bash
pocketterminal-notify progress 'Backend finished; checking the deployment now.'
pocketterminal-notify blocked 'Deployment needs your DNS change before I can continue.'
pocketterminal-notify question 'Should I keep the old backup? Open Target controls to reply.'
pocketterminal-notify done 'Implementation and focused checks finished. Details are in the terminal.'
pocketterminal-notify error 'Build failed; investigating. Existing service is still running.'
```

The helper detects a managed tmux terminal using **socket + server PID + pane**,
not a guessed project/name. New/resumed managed jobs also inherit the non-secret
`PT_SESSION_ID`, usable when a CLI filters tmux variables. An explicit
`--session EXACT_32_HEX_ID` is available; it must exist on this VPS. Outside managed
terminals use `--unlinked`: messages clearly say **Unlinked agent**, without a
misleading target button. With no terminal context, this is automatic. The
optional project label is just a basename, not a full working path.

Use `--stdin` instead of a message argument to avoid putting text in argv/history:

```bash
printf '%s' 'The requested migration is ready for your review.' | pocketterminal-notify progress --stdin
```

**Do not send passwords, API keys, .env contents, private files or transcripts.**
Telegram bot chats are not end-to-end encrypted. Nothing scrapes terminal output.
The helper neither reads nor needs the bot token; it is not a security sandbox
against root, who already controls this host. It cannot choose another recipient.

## Install on any supported Linux VPS

1. Deploy/build PocketTerminal normally and configure ordinary Telegram or join
   the [shared fleet](telegram-fleet.md). Notifications must be on for this VPS.
2. Reload **only the web service**, preserving tmux jobs as described in
   [operations](OPERATIONS.md#upgrade-and-rollback).
3. From the installation directory, as root, install the command using this
   installation's own `PT_DATA_DIR` (not the other server's configuration):

   ```bash
   cd /opt/pocketterminal
   bash scripts/install-agent-notify.sh /var/lib/pocketterminal
   pocketterminal-notify --help
   ```

   For an in-place deployment the data directory may instead be
   `/root/projects/PocketTerminal/.runtime/production`.
4. Add the following guidance to the effective global Codex `AGENTS.md` (normally
   `~/.codex/AGENTS.md`, or `AGENTS.override.md` if that already takes precedence),
   and to `~/.claude/CLAUDE.md` if using Claude Code. **Append without overwriting
   your existing instructions.** Respect a custom `CODEX_HOME`/Claude config home.

   ```markdown
   ## PocketTerminal important Telegram updates
   Use /usr/local/bin/pocketterminal-notify to send concise, important updates
   during work: progress milestones, blockers, questions needing the owner's
   decision, meaningful errors, and a final done summary when actually verified.
   Example: pocketterminal-notify blocked 'Need your DNS change to continue.'
   Do not notify for every tool call or reasoning step. Normally the lead agent
   reports; subagents report only distinct urgent blockers, avoiding duplicates.
   Never send secrets, credentials, private files or terminal transcripts.
   Use the existing terminal context; never guess another session ID. If context
   is unavailable, use --unlinked and say which task needs attention in the text.
   A question notification does not authorize a decision: wait for the owner.
   Keep normal terminal replies too. If delivery is rejected/unknown, report it
   in the terminal, do not loop or automatically retry, and continue safe work.
   Telegram acceptance is not a read receipt; a done message is not evidence
   unless you really verified the result. Respect any task-specific restriction
   on external sharing. See pocketterminal-notify --help for syntax.
   ```

Codex reads global instructions **once at session launch** ([official guidance](https://developers.openai.com/codex/guides/agents-md/)).
Existing sessions are not restarted or silently injected with prompts. Tell an
already-running agent to use `pocketterminal-notify` in your next prompt, or use
the deliberate Exit & Resume flow when idle. Other/custom agent profiles need
the same guidance in their own instruction file. Instructions encourage use;
they cannot guarantee a model reports every important event.

## Replies and notification controls

- Use the message's **Target controls**, then **Send prompt** or the existing
  key/input controls. They stay bound to the originating VPS/session even after
  switching servers. A plain reply to an update is **not executed** as input.
- `/notifications` controls both automatic alerts and these updates for the VPS
  named on that menu. Other VPSs remain independent. Emergency disable/revoke
  drops pending updates without stopping jobs.
- Exit code **0** means Telegram accepted the update, **1** means rejected/local
  failure, **2** means delivery is uncertain. No receipt means no delivery claim.
  A duplicate-suppressed result is not confirmation that the earlier attempt
  reached the phone. Do not blindly retry after network loss or restart.

## RAM, delivery and security acceptance criteria

- No frontend change, additional browser renderer, terminal buffer, PTY,
  transcript reader, database row, daemon, worker token or second Telegram poller.
- A private `0600` Unix socket inside the `0700` data directory; no public API
  bypass. At most **4 clients**, **8 KiB/request**, **1 KiB/reply**, a **3s** receive
  deadline and a **26s** delivery deadline (under **30s** total). CLI socket
  deadline **30s**.
- At most **4 short messages including the in-flight one**, each **2000 UTF-8
  bytes**, expiring after **25s**. The existing actor sends at most one per turn,
  after processing owner commands, using existing fleet pacing. No concurrent
  use of the actor's transport or sleep slot.
- Per-VPS burst **4**, then at most **1 admission/10s**; per session/category
  cooldown **30s**. A blocker/question can follow a progress update immediately.
  Identical session/category/text suppressed for **5 minutes**, with at most
  **64 hashes** and **64 cooldown records**. No full text retained for dedupe.
- Disconnect, expiry, disable, known offline failure and shutdown clear pending
  text/listeners; failed or uncertain sends are never replayed. No disk outbox.
  Delivery is best effort while online; simultaneous fleet work may be delayed
  by Telegram. Critical decisions must also remain visible in the terminal.
- Focused tests must cover target collisions, unauthorized socket access,
  malformed/oversized requests, concurrency, dedupe, deadlines, reconnect churn,
  disable, disposal and updates from multiple nodes without selection changes.
  Observe backend RSS/FD stability and empty pending text after churn; do not
  describe a short synthetic check as a prolonged phone or memory soak.
