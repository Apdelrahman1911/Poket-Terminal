# Operations (single-owner Linux host)

Install via the [README](../README.md). Commands here are **operator actions on
your own host**, not publication/deployment automation. Preserve unrelated tmux
servers, existing jobs, project folders and private provider configuration.

## Start, status, reload and stop

For the documented systemd unit:

```bash
systemctl start pocketterminal
systemctl status pocketterminal --no-pager
curl --fail http://127.0.0.1:3000/health
systemctl reload pocketterminal   # HUP: restart Node with the SAME supervisor env
systemctl restart pocketterminal  # controlled supervisor relaunch; rereads env
systemctl stop pocketterminal     # stops web only; tmux jobs continue
```

**Keep `KillMode=process`, `SendSIGKILL=no` and the Python supervisor.** Do not
substitute systemd's default cgroup cleanup, `pkill`, `killall`, all-tmux kills or
force-kill a unit cgroup. The supervisor closes browser attachments and terminates
its own web process group; detached tmux servers/jobs are separate. Stop can take
up to about ten seconds. A hung stop requires diagnosis, not killing unknown PIDs.
A host reboot/power loss ends all RAM processes: session metadata becomes stopped
without automatic reruns. Explicitly resume CLI histories only when intended.

`/health` is only liveness, not an auth/GUI/model success check. Private service
logs are in `PT_DATA_DIR/service.log` (three bounded ~1 MiB files). `journalctl -u
pocketterminal` reports supervisor/service startup. Do not add request-body or
terminal-content logs. SSH access on the job's displayed attach command uses the
fixed `tmux -L pocketterminal`; Ctrl+B, D detaches without ending it.

## Environment changes and tmux fallback

`scripts/runtime-env.sh` is sourced **once**, then Bash execs Python. HUP creates a
new Node process with the old inherited environment. A new export/file edit alone
cannot change origin, data directory, Telegram pins or Codex defaults on reload.
For those settings use a controlled supervisor restart with the same fixed
installation/data settings. Do not accidentally switch databases or tmux sockets.

For the README's non-systemd tmux fallback, inspect the dedicated web pane:

```bash
PID=$(tmux -L pocketterminal-web display-message -p -t '=web:0.0' '#{pane_pid}')
ps -p "$PID" -o pid,ppid,args  # MUST be scripts/supervisor.py for this installation
# Only after checking identity, and immediately before signalling:
kill -HUP "$PID"              # Node-only reload, existing env
# Or kill -TERM "$PID" for deliberate web shutdown; wait until that pane ends.
```

To reload env in fallback mode, deliberately stop **that verified supervisor**,
wait for its clean exit, then repeat the README's explicit web launch command
which sources `/etc/pocketterminal/env`. Never recreate a missing owner-job pane,
kill `-L pocketterminal`, or signal a stale PID read long ago. Do not run systemd
and fallback launchers simultaneously. Unrelated owner jobs remain independent.

New web configuration applies on restart; existing tmux servers and jobs keep
their original inherited tool environment. To update tool PATH/JDK variables,
explicitly export them in the intended shell. Ending all jobs/server solely to
refresh environment is not required or recommended. Private CLI configuration
files are read by newly launched CLIs, not retrofitted into existing agents.

## Upgrade and rollback

Build **only a disposable candidate**, never live `dist`. Keep the installation
path stable: Telegram state is under `/opt/pocketterminal/.runtime/telegram`,
whereas SQLite is at `PT_DATA_DIR`. Do not symlink the protected private Telegram
directories to a release (its permission/type checks intentionally reject that).

Example operator procedure, after reviewing the next commit and checking the
current checkout has no local source changes:

```bash
cd /opt/pocketterminal
git status --short
git fetch origin
NEXT=REPLACE_WITH_REVIEWED_COMMIT_SHA
OLD=$(git rev-parse HEAD)
git worktree add --detach /opt/pocketterminal-candidate "$NEXT"
cd /opt/pocketterminal-candidate
npm ci
npm run build
npm --prefix desktop ci
npm --prefix desktop run build
npm run test:publication
npm --prefix desktop test
npm --prefix desktop run test:limits
# Review results/diff; do not deploy a failed or unreviewed candidate.
cd /opt/pocketterminal
set -a; source /etc/pocketterminal/env; set +a
source scripts/runtime-env.sh
npm run backup
install -d -m 0700 ".runtime/releases/$OLD"
cp -a dist ".runtime/releases/$OLD/dist"
printf '%s\n' "$OLD" > .runtime/previous-commit
# Record/review dependency changes too; preserve the old native dependency install.
systemctl stop pocketterminal
mv node_modules ".runtime/releases/$OLD/node_modules"
# Only on a clean source tree, after review; never overwrite local owner edits.
git switch --detach "$NEXT"
cp -a /opt/pocketterminal-candidate/node_modules ./node_modules
# Preserve older hashed assets for open tabs, but replace obsolete server modules.
rm -rf dist/server
cp -a /opt/pocketterminal-candidate/dist/. dist/
systemctl start pocketterminal
```

Use an unused backup/candidate directory for each upgrade; never overwrite a
frozen release. Check service health, HTTPS login, old session identities and the
selected device. Refresh open tabs for compatible client code. These example
paths are application-owned, not permission to delete unrelated files. The
reviewed code still targets the existing schema; never assume future migrations
are backward compatible. No global npm/provider/model configuration is upgraded.

Rollback: stop **web only**, read the recorded old commit, restore its source and
saved `dist`/`node_modules`, restore the private env only if intentionally changed,
and start the same unit. Do not reset the password/bot binding as part of a routine
code rollback. Keep any failed candidate files separately rather than overwriting
the last good release. If a future release changes the database schema, follow
its migration-specific restore plan with the service stopped; retain the failed
database/WAL for recovery and do not merge two live databases.

Desktop native helper/assets are a **separate opt-in upgrade**. A web update does
not require killing/restarting the GUI. See [desktop rollback](../desktop/DEPLOYMENT.md).
Never run desktop provisioning just because you updated the terminal client.

## Private CLI and backups

Always use the correct private environment before a CLI (no automatic dotenv):

```bash
cd /opt/pocketterminal
set -a; source /etc/pocketterminal/env; set +a
source scripts/runtime-env.sh
npm run telegram -- status
npm run backup
# npm run password -- reset   # deliberate private TTY reset, if needed
```

The SQLite online backup API writes a verified consistent 0600 snapshot under
`PT_DATA_DIR/backups`. Do **not** `cp` the live `.sqlite` without its WAL or use a
raw directory copy as the database backup strategy. Backups hold password hashes
and authentication metadata; encrypt/restrict them, keep bounded retention and
test restore privately. The database contains session metadata, not terminal
transcripts. Root/Codex/Claude histories are independent private tool state.

Back up source commit/lockfiles, the private env, projects, necessary CLI state
and (if enabled) GUI home, plus `.runtime/telegram` state separately under authorized
secure backup rules. Telegram state is actually in the **application root**, not
the GUI home or `PT_DATA_DIR`: `/opt/pocketterminal/.runtime/telegram`. Quiesce bot
updates with `npm run telegram -- disable` before an exact private copy; use
`enable` interactively afterward if desired. Do not include live `/run` sockets,
Xauthority, screenshots, terminal captures, dependencies or logs in source Git.

For DB restore: close public access/stop web, retain the current DB/WAL/SHM,
restore the verified backup as `pocketterminal.sqlite` with root ownership/0600
inside the existing 0700 data directory, with stale WAL/SHM moved aside while
stopped. Privately reset the owner password before reopening public access so old
login sessions are not resurrected. Reconcile actual tmux identities; a metadata
restore cannot resurrect RAM jobs and must never rerun ended work automatically.

## Troubleshooting

| Symptom | Check / safe response |
|---|---|
| Node fails config/start | Node 24, `npm ci`, compiled `dist`, root-readable 0600 env, exact HTTPS origin, existing direct-child default cwd. No `.env` autoload. |
| Password works on CLI but site says setup needed | CLI and supervisor must use the exact same `PT_DATA_DIR`; do not initialize/reset another DB blindly. |
| HTTPS 502 | Local `/health`, unit logs, actual bind port, Caddy target and Node version. Do not publish the Node port to work around it. |
| 403 / WS rejection | Exact Host/Origin including non-default port, same-origin URL, secure cookie, CSRF, proxy preserving headers; refresh/login. No CORS bypass. |
| Login rate limit | Wait up to 15 minutes. Forwarded IPs are deliberately untrusted; clients behind one proxy share its bucket. |
| Codex missing/provider error | Same owner auth/config and PATH; check `codex --version`, private login, model/provider compatibility. No automatic paid smoke test. |
| Desktop button absent after env edit + HUP | Supervisor still has old env. Use the private persistent opt-in, or controlled supervisor restart. See desktop setup. |
| Desktop Chrome cannot create threads | Child NPROC must be 512; threads count. Existing GUI processes inherit their old limits until separately updated/restarted by an operator. Never disable sandbox/site isolation/web security. |
| Black/disconnected desktop | `pocketdesktop status`, secure socket/assets/account permissions, reauthenticate/reconnect. A native X crash ends GUI apps; web reload normally does not. |
| Telegram stopped | Correct configured numeric bot ID AND username, no webhook, paired private numeric user/chat, private 0700/0600 state. Env-only identity switch fails closed; revoke/re-pair privately. |
| Copy/scroll/keys on phone | Reconnect selected terminal, exit history/Take control, use Copy output selectable text fallback; desktop clipboard is manual Latin-1 only. |
| Memory pressure | Count Node, tmux/agents/builds, all GUI apps and browser processes separately. NPROC and V8 heap limits are not RSS quotas; reduce intentional workload, not sandboxing. |
| Metadata says stopped | Check actual owned tmux session; exits/reboot are not task success. Never recreate an ended owner job automatically. |

A directory mtime difference is consistent with active owner work, not proof of
its cause. Do not "repair" it or overwrite unrelated files during upgrades.
