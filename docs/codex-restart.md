# Restart and resume Codex

## Owner workflow

1. Edit this VPS's private Codex configuration; do not put credentials in Git.
2. Select the running Codex card. Prefer to wait for **Ready** (not proof of task success).
3. Click **Restart & resume** and read the interruption/draft warning.
4. The same entry returns with the same saved conversation. Send a new prompt
   yourself when ready; in-flight work, tool processes and sub-agent execution
   are not promised to resume from the same instruction.

The website disconnect button remains a viewer-only operation. This new button
intentionally exits the CLI. Other sessions and the desktop are not restarted.
Direct SSH input is outside web/Telegram input arbitration: do not type or change
the target pane concurrently. A stopped entry linked by an earlier restart has
**Resume Codex**; older unlinked stopped entries use the CLI picker manually.

## Safety and failure behavior

- Authenticated same-origin POST, CSRF, exact entry confirmation, strict JSON
  schema, and `expectedUpdatedAt` reject stale/double submissions.
- One operation globally, no queue; the target retains a reservation and the
  normal 20-session ceiling also applies when resuming a stopped entry.
- Read-only, on-demand inspection follows only the native Codex process or its
  known npm launcher. It reads bounded `session_meta` headers of already-open
  rollout files. Only one `source: "cli"` identity with matching UUID/directory
  is accepted; sub-agent rollouts are excluded. No `--last` or directory-wide
  history scan. More than one pane, unknown program, ambiguous identity, missing
  saved history or inaccessible metadata refuses the operation.
- The entry is blocked for browser/Telegram input and new attachment allocation;
  its existing attachments/input are disposed before exit. Other entries stay
  attached. Codex's native Ctrl+C exit sequence is guarded by process instance,
  exact tmux session/pane/PID, and repeated conversation identity checks. It
  clears a draft/interrupts/exits normally; **no Unix kill signal** is sent to the
  CLI or its process group. A pidfd plus bounded `/proc` checks monitor exit.
- `respawn-pane` has **no `-k`**: tmux refuses a live replacement. There is no
  forced-kill fallback or automatic restart retry. The saved UUID remains for
  deliberate recovery after a confirmed exit, bad config or interrupted request.
  A transport timeout is an **unknown result**, not proof it failed: refresh first.
- Current Codex files are read by the new process. Web launch overrides keep
  precedence; changing a supervisor environment variable still needs a separate
  deliberate supervisor relaunch. Provider credentials/config are never copied
  between hosts or captured in resume metadata.

Official OpenAI documentation: [CLI resume](https://learn.chatgpt.com/docs/developer-commands?surface=cli)
and [configuration precedence](https://learn.chatgpt.com/docs/config-file/config-basic).

## Memory/storage acceptance criteria

- No additional idle worker, PTY, watcher, socket or recurring timer. One
  on-demand Python helper at a time, 8-second process deadline, 4 KiB result cap;
  at most 8,192 process entries, 1,024 descriptors and 128 candidate headers of
  128 KiB each, processed one at a time. Headers/content are never logged or
  returned to the browser. No transcript is retained by Node.
- Existing SQLite schema v1 is unchanged. Existing `metadata` stores only
  `codex_resume:<terminal-id>` → 36-character UUID. Record removal/pruning cleans
  the mapping; normal private online backups/rollback remain compatible.
- Only the selected visible terminal renders. During its restart it is disposed,
  then recreated once; switching away while a restart is pending never switches
  selection back or rebuilds a different renderer. Inactive sessions keep only
  bounded catalog metadata. Existing xterm/transport/PTY bounds remain unchanged.
- Fast background/foreground transitions carry a small activation generation:
  even when React batches hide/show updates, a disposed terminal is recreated
  exactly once rather than retaining a dead instance. No output is React state.
- Focused checks cover exact ID/new PID, current launch arguments, auth/CSRF,
  stale and concurrent requests, cap enforcement, refusal/uncertain exit, stopped
  recovery, metadata cleanup and mobile switching/reconnection allocation counts.

## Repeatable focused checks

```bash
npm run build
mkdir -p .runtime/evidence
node_modules/.bin/tsx --test --test-concurrency=1 tests/codex-restart.test.ts tests/db.test.ts
# An installed sandboxed Playwright Chromium is required; optionally point to it:
PT_UI_BROWSER_EXECUTABLE=/path/to/chrome-headless-shell npm run test:restart-ui
# Optional Linux contract test using installed Codex, a dummy loopback provider,
# isolated HOME/config/project and its own test tmux socket (no paid inference):
python3 tests/codex-native-restart.py
```

Browser evidence includes 20 metadata cards, 32 restart/switch/background cycles,
heap samples, one-active/zero-detached renderer/socket counts. Native evidence
records exact conversation/PID/pane continuity and normal exit. Synthetic tests
do not substitute for physical-phone testing, a long memory soak, or a paid
end-to-end model task. No owner job is used for acceptance testing.
