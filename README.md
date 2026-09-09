# PocketTerminal + Telegram + PocketDesktop

A **single-owner VPS terminal** for a phone or desktop browser. Shell/Codex jobs
live in independent tmux sessions; closing a tab, losing the network, logging out,
or restarting the web gateway does not stop them. Optional Telegram controls the
same sessions. Optional PocketDesktop is one persistent, private, non-root XFCE
screen over the same authenticated HTTPS origin.

**Security warning:** the documented web/terminal service runs as **root**. A web
login, a paired Telegram account, or an agent launched here can control the host.
Codex is deliberately launched with `danger-full-access` and approval `never`.
This is not a multi-user sandbox or a safe place for untrusted users/code. Use a
dedicated VPS, unique strong password, private SSH, trusted devices and backups.
The non-root GUI boundary does not turn the whole product into a hardened VM.

Tested platform: **Ubuntu 24.04 LTS x86_64**, Node **24**, Python 3.12, tmux 3.4.
Other distributions, architectures, systemd environments and physical phones
are not claimed tested. This repository is a portable **source-only export**, not
a production state backup. No password, bot token, provider account, private
Codex configuration, domain configuration or prebuilt binary is included.

## What is included

- Root: React/xterm client, Fastify HTTPS-origin gateway, SQLite metadata/auth,
  terminal ownership/backpressure, Python foreground web supervisor and Telegram.
- `desktop/`: private TigerVNC/XFCE supervisor/provisioner, bounded noVNC 1.7.0
  client and the minimal MPL-2.0 patch with upstream hashes/licenses.
- `deploy/`: ordinary Caddy and systemd examples; **no provider-specific boot API**.
- `docs/`: [operations](docs/OPERATIONS.md), [security](docs/SECURITY.md),
  [protocol](docs/PROTOCOL.md), [copy/status](docs/copy-status.md),
  [Telegram](docs/telegram.md). Desktop has its own
  [setup](desktop/DEPLOYMENT.md) and [limits](desktop/SECURITY_AND_BOUNDS.md).

## Fresh VPS installation (ordered)

Run these instructions **on your own new VPS**, in a private root SSH shell
(`sudo -i` if needed). They are deployment instructions, not an automatic installer.
Do not paste them into an existing installation without reviewing the paths and
[upgrade procedure](docs/OPERATIONS.md#upgrade-and-rollback).

### 1. Host, DNS, network and packages

Use a dedicated name, e.g. `terminal.example.com`. Set its **A** record to your
VPS IPv4; add **AAAA only if that IPv6 address actually works**. No special DNS
provider, workspace ID or jump host is needed. Keep SSH access open while making
firewall changes. Allow TCP **22** (or your actual SSH port), **80**, **443** in
both the VPS/provider firewall and host firewall; expose **neither 3000 nor
9990 nor X11/VNC ports**. Do not blindly reset an existing firewall.

```bash
apt-get update
apt-get install -y ca-certificates curl xz-utils git openssh-client \
  build-essential pkg-config python3 tmux openssl patch
# Optional, only when you choose to use UFW on this fresh host:
# ufw allow 22/tcp; ufw allow 80/tcp; ufw allow 443/tcp; ufw enable
```

Install a reviewed **Node 24.x** release from [nodejs.org](https://nodejs.org/en/download).
Ubuntu's default `nodejs` package may be older. Example official binary install
(x86_64 only; choose the actual version from the official release list):

```bash
install -d -m 0700 /root/pocketterminal-setup/node
cd /root/pocketterminal-setup/node
read -r -p 'Reviewed Node release (v24.x.y): ' NODE_VERSION
[[ "$NODE_VERSION" =~ ^v24\.[0-9]+\.[0-9]+$ ]] || exit 1
curl --fail --location --proto '=https' --tlsv1.2 -O \
  "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz" || exit 1
curl --fail --location --proto '=https' --tlsv1.2 -O \
  "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" || exit 1
grep " node-$NODE_VERSION-linux-x64.tar.xz$" SHASUMS256.txt | sha256sum -c - || exit 1
# Review official signed-checksum verification instructions before extracting.
# The above checksum alone relies on the authenticated download source.
tar -xJf "node-$NODE_VERSION-linux-x64.tar.xz" -C /usr/local --strip-components=1
node --version   # must be v24.x
npm --version
```

### 2. Authenticate to GitHub and clone privately

For a private repository, authorize your own SSH key/read-only deploy key in
GitHub first. Verify GitHub's SSH host-key fingerprint using its official docs.
Never embed a personal access token in a clone URL, command, shell history or
this repository. See [GitHub SSH setup](https://docs.github.com/en/authentication/connecting-to-github-with-ssh).
Alternatively use `gh auth login` interactively with HTTPS, then `gh auth setup-git`.
Do not overwrite an existing SSH key.

```bash
git clone git@github.com:Apdelrahman1911/Poket-Terminal.git /opt/pocketterminal
# HTTPS alternative after private credential-helper authentication:
# git clone https://github.com/Apdelrahman1911/Poket-Terminal.git /opt/pocketterminal
cd /opt/pocketterminal
npm ci
npm run build
install -d -m 0700 .runtime /var/lib/pocketterminal
install -d -m 0755 /srv/projects /srv/projects/default
```

`npm ci` uses the committed lockfile; native modules require the build tools
above. Do not run dependency upgrades as part of deployment. The default project
picker offers existing non-hidden **immediate child directories** of
`PT_PROJECT_ROOT`; `PT_DEFAULT_CWD` must be one of them. Launch-time realpath
checks reject escapes and symlinks outside that root. Project data is independent
of session metadata; Delete never deletes project files.

### 3. Private configuration and password — before public exposure

```bash
install -d -o root -g root -m 0700 /etc/pocketterminal
install -o root -g root -m 0600 .env.example /etc/pocketterminal/env
nano /etc/pocketterminal/env
```

Replace the placeholder `PT_ORIGIN` with your **exact canonical HTTPS origin**,
for example `https://terminal.example.com` (no trailing slash/path/query/wildcard,
credentials or explicit default `:443`). Set literal absolute data/project paths.
Keep `PT_HOST=127.0.0.1`. The backend **does not trust forwarded Host/Origin/IP
headers**, and the proxy must preserve the original Host and Origin.

This file is consumed by both Bash and systemd: use simple literal `NAME=value`
entries (quotes for spaces), no `export`, `$HOME`, substitutions or shell commands.
It is root-owned 0600; no default password, bot token or provider secrets belong
in it. `.env` is **not automatically loaded** by Node/npm. For **every private
password, Telegram or backup CLI invocation**, load the same environment:

```bash
cd /opt/pocketterminal
set -a
source /etc/pocketterminal/env
set +a
source scripts/runtime-env.sh
npm run password -- init
```

Use a private interactive SSH TTY: hidden input and confirmation are required.
No password in argv/env, no browser setup/reset endpoint. Use 16+ characters with
three character classes, or a varied 24+ character passphrase. `init` refuses to
replace an existing owner; `npm run password -- reset` deliberately revokes all
web logins but preserves jobs. Keep the env file/path consistent or you could
initialize a different, unused database.

### 4. Start the web gateway without sacrificing independent jobs

On a fresh host with systemd as PID 1:

```bash
install -o root -g root -m 0644 deploy/pocketterminal.service \
  /etc/systemd/system/pocketterminal.service
systemctl daemon-reload
systemctl enable --now pocketterminal
systemctl status pocketterminal --no-pager
curl --fail http://127.0.0.1:3000/health
```

The **complete unit** is [deploy/pocketterminal.service](deploy/pocketterminal.service).
`ExecStart` execs the existing Python foreground supervisor; it owns web child
shutdown/recovery and logging. **`KillMode=process` is essential**. Default
`control-group`, `mixed`, cgroup-wide kills, `PrivateTmp`, or low unit-wide task/RAM
limits can kill/strand/starve independent tmux jobs. `SendSIGKILL=no` avoids a
fallback group kill; investigate a stop timeout, never "fix" it with `pkill`.
The isolated supervisor HUP/crash/stop/relaunch test verifies an unchanged tmux
pane survives. The systemd unit itself has **not** been live-tested in this
publication environment; verify it on your new host before valuable work.

**Without systemd**, run only the web supervisor in a separate tmux server:

```bash
# Same private root shell; env will be loaded inside the new pane.
tmux -L pocketterminal-web new-session -d -s web \
  "cd /opt/pocketterminal && set -a && source /etc/pocketterminal/env && set +a && exec ./scripts/service.sh"
tmux -L pocketterminal-web attach -t web  # inspect; Ctrl+B, D detaches
```

Use `-L pocketterminal-web` only for the web supervisor. Owner jobs use the
separate fixed `-L pocketterminal` socket. Do not run both launch methods or kill
an entire tmux server. [Operations](docs/OPERATIONS.md) explains identity-checked
HUP/stop and environment reload. A VPS **reboot cannot preserve RAM processes**;
metadata is reconciled to stopped, never silently rerun.

### 5. HTTPS reverse proxy

After password initialization and a healthy loopback backend:

```bash
apt-get install -y caddy
install -o root -g root -m 0644 deploy/Caddyfile /etc/caddy/Caddyfile
nano /etc/caddy/Caddyfile  # replace terminal.example.com with your exact DNS name
caddy validate --config /etc/caddy/Caddyfile
systemctl enable --now caddy
systemctl reload caddy
```

The [example](deploy/Caddyfile) uses `reverse_proxy 127.0.0.1:3000`: Caddy handles
HTTP→HTTPS, certificates and WebSocket upgrades automatically. Do not rewrite
Host/Origin, add permissive CORS, publish the Node port, enable request-body logs,
or use an unrelated site to serve these clients. Certificate issuance requires
working DNS and port 80/443 reachability. Caddy's service logs are not terminal
logs; the example does not enable access logging.

Verify `curl -I http://terminal.example.com/` redirects to HTTPS, open the HTTPS
site and log in, and check that only SSH/HTTP/HTTPS listen publicly. Both clients
change an accidental HTTP page to **HTTPS on the same host** before mounting
login UI; this is only defense in depth (HTTP JavaScript can be tampered with).
**Proxy TLS/redirect enforcement is still mandatory.**

## Daily browser and phone use

Create a **Shell** first to check project selection. Create **Codex** after the
optional CLI setup below. Only the selected visible terminal renders; other jobs
continue without a viewer. Tap **Take control** when view-only; browsers and
Telegram share input ownership. SSH attaches directly and is outside that rule.
Use the soft keyboard/key row for Ctrl, Esc, Tab, arrows and Enter. Long output
is bounded, not a transcript recorder.

- Scroll recent terminal history; use **Live** to leave history safely before
  typing. Full-screen apps may not retain old screens. Ctrl+B, D detaches tmux.
- **Copy output → Copy visible / Copy recent → Copy text** opens a temporary
  plain-text snapshot (200 lines / 64 KiB). Native select/copy is the fallback if
  clipboard permissions fail. Closing the view discards it; an already-written
  system clipboard cannot be erased by the app.
- Lifecycle and Codex activity are separate. **Ready is not task success**;
  generic shells/older or unfamiliar CLI titles report activity unavailable.
- **Rename** changes a label. **Stop** explicitly ends the selected job's entire
  tmux session. **Delete** is only for stopped metadata, never project/CLI history.
- Backgrounding or disconnecting drops viewers/input queues; reauthenticate or
  reconnect on return. No queued keystrokes are replayed. Logout revokes viewers,
  not jobs. If a browser's native closing socket stalls, reload rather than
  creating overlapping connections.
- Desktop has Fit/pan, keyboard modifiers and manual clipboard. Clipboard is
  browser→desktop Latin-1 text only, max 4 KiB; no automatic read, file transfer,
  audio or desktop→browser clipboard. Physical iOS/Android keyboard/clipboard and
  OS background behavior require device acceptance, not just viewport emulation.

## Optional tools

### Codex CLI and private owner configuration

Install/authenticate **privately as the same owner that runs the terminal**:

```bash
npm install -g @openai/codex
codex --version
codex login
# Headless alternative if your account/settings support it:
# codex login --device-auth
```

Use the current [official CLI](https://developers.openai.com/codex/cli/),
[authentication](https://developers.openai.com/codex/auth/) and
[config reference](https://developers.openai.com/codex/config-reference/) docs.
Never commit `~/.codex`, tokens, config snapshots or session history. No paid
model test is required to install/build PocketTerminal.

By default we use the owner's authenticated Codex model/provider/reasoning
configuration; only terminal-title telemetry and **full-access / never-approve**
are added. Optional `PT_CODEX_MODEL`, `PT_CODEX_PROVIDER` and
`PT_CODEX_REASONING_EFFORT` are validated argument values, not shell source.
Overrides apply on a new launch, not an existing running Codex process. Reasoning
support depends on the installed CLI/model: common choices include low/medium/
high/xhigh; no effort is forced by default. The `max` compatibility value is for
private/custom installations, **not a promise of general API support**. An
existing owner may privately supply `gpt-6-astra` / `azure_astra` overrides and
credentials; these are not bundled defaults or generally available endpoints.

Optional owner-only Codex configuration (do not apply to someone else's file):

```toml
[agents]
max_threads = 9
```

This is a concurrency ceiling, not nine prestarted workers or a RAM quota.
Current docs also name `max_concurrent_threads_per_session`; `max_threads` is a
legacy alias. Check your installed CLI's support. More agent jobs can consume
more RAM and billable usage. PocketTerminal does not modify global agent config.

### Claude Code

Optional, not required by the server. Follow the current
[official installation/authentication](https://code.claude.com/docs/en/quickstart)
instructions for your plan/platform (review any downloaded installer before
running it). For the official native installer, download `https://claude.ai/install.sh`
privately, review it, then run it with Bash; verify `claude --version` and start
`claude` in a **Shell** session to authenticate interactively. Keep its private
credentials/history outside Git; never place them in the README or `.env.example`.
There is no forced Claude provider or automatic model smoke test.

### Kotlin Multiplatform / Android

Optional and substantially heavier than the gateway. Install a supported JDK
(e.g. `apt-get install openjdk-21-jdk` if your project's Gradle supports it) and
Android command-line tools from [developer.android.com/studio](https://developer.android.com/studio).
Verify the archive; install to your chosen SDK directory, use `sdkmanager` to
install **your project's** platform/build-tools, and accept Android SDK licenses
only after you have read/are authorized to accept them. Use the project's Gradle
wrapper; do not blindly replace it or install an emulator on a small VPS.

Set literal `JAVA_HOME`, `ANDROID_HOME`, `ANDROID_SDK_ROOT`, and PATH entries for
`cmdline-tools/latest/bin` and `platform-tools` in the private env file. No
`/etc/profile.d` owner file is auto-sourced. Relaunch the web supervisor to reload
env (HUP alone is insufficient); existing tmux servers/jobs retain their original
environment, so explicitly `export` updated paths inside the selected shell or
start a fresh server only after intentionally ending all its jobs. Do not kill
jobs merely to refresh tool paths. SDK builds and browsers need extra RAM/disk.

## Optional Telegram setup

Telegram is off/unpaired unless explicitly configured and privately paired.
**Bot chats are not end-to-end encrypted; the paired account gains root terminal
control.** Do not send credentials. Full steps: [docs/telegram.md](docs/telegram.md).

1. Create your own bot with official **@BotFather**. Put its exact username
   (without `@`) and numeric bot ID (token prefix before `:`) in the private env
   as `PT_TELEGRAM_BOT_USERNAME` and `PT_TELEGRAM_BOT_ID`. Set **both**; no token in env.
2. Load the private env using the password section's `set -a; source ...; set +a`
   block. In a private SSH TTY with tracing/recording off, use the linked guide's
   hidden `read -s` / Bash builtin write to create root-owned **0600**
   `/opt/pocketterminal/.runtime/telegram/token` under **0700** directories. Never
   put a token in argv, URLs, shell history or Git. This is not `PT_DATA_DIR`.
3. Restart only the web supervisor to load the pins (`systemctl restart
   pocketterminal`, job-preserving unit). Run `npm run telegram -- pair` from
   the installation root with the same env. Confirm **PAIR** in SSH, send the
   five-minute `/pair CODE` challenge to that bot in your **private** chat, then
   verify/type **BIND numeric-user-id numeric-chat-id** in SSH. Username alone
   never authenticates. `getMe` must match both bot pins; webhooks are refused.
4. Open the bot's **Menu** or `/sessions`. Use `/new` for a confirmed new job,
   choose the exact target for `/prompt`, keys, `/output`, Stop/Delete or control
   takeover. Notifications report observed needs-input/ready/exit, not task success.
5. `npm run telegram -- status` checks local state; `disable` stops polling and
   pending controls without killing jobs; `revoke` removes the binding; `enable`
   privately reverifies it. Bot identity/legacy-state changes require **revoke →
   update pins/token → supervisor restart → re-pair**, not an env-only switch.
   Old commands/confirmations are never replayed; real device acceptance is yours.

## Optional private desktop

Desktop is **off/unprovisioned by default**, with no additional public port.
See the complete [desktop installation, activation and rollback](desktop/DEPLOYMENT.md).
In short, on the new host only:

```bash
cd /opt/pocketterminal
npm --prefix desktop ci
npm --prefix desktop run build
python3 -I desktop/scripts/provision.py --packages \
  --client desktop/.runtime/candidates/client/client
# This installs private helpers/accounts/assets; does NOT start the GUI/web app.
```

Then create the documented root-owned 0700 `/etc/pocketdesktop` directory and
0600 `gateway.json` opt-in, and reload **only the web backend**. Connect from
`/desktop/` or use the explicit root CLI. Keep `PT_DESKTOP_ENABLED` unset when
using the persistent file. A long-lived supervisor sourced env **once**; exporting
`PT_DESKTOP_ENABLED=1` somewhere does not update it on HUP.

The desktop account is password-locked, non-root, has no sudo and does not inherit
root's auth environment. It cannot access `/root` projects/keys. Use an explicitly
shared non-secret folder, or clone a separate project inside the GUI account's
home; **never chmod /root open**. Install GUI apps separately if wanted. Launch
Chrome as the desktop user normally, with all browser/renderer/network sandbox,
site isolation and web-security protections intact. No sandbox-disabling flags.

## Memory, persistence and honest limits

Application queues are bounded, **not total-process RAM guarantees**. Node uses
`--max-old-space-size=96` (V8 heap, not RSS); at most 20 live jobs, 32 retiring/live
terminal attachments, xterm 500-line scrollback and tmux 2,000 lines per pane.
Desktop is 1280×720×24, max 15 fps, max two authenticated viewers and one per auth
session; one noVNC instance per visible page. It disconnects slow readers instead
of retaining unbounded frame history. Patched receive/render/send bounds are in
[SECURITY_AND_BOUNDS](desktop/SECURITY_AND_BOUNDS.md).

The desktop child **RLIMIT_NPROC is (512,512)**. Linux counts **threads per real
UID**, not just processes; sandboxed Chrome 153 exhausted a previous 256 limit
(`pthread_create` EAGAIN/SIGTRAP). 512 provided thread headroom in a separate
coordinator check. It **does not reserve/preallocate RAM**, impose a RAM quota or
guarantee arbitrary sites fit. Browsers, sites, builds and owner agent jobs add
site/workload-dependent memory; do not disable sandboxes to work around limits.

Historical original-build observation (not a new publication benchmark): a real
**237.743 s / 2,772-changing-screen** test found desktop all-process RSS/PSS
**298.78/119.55 MiB**, Node one-viewer RSS **105.91 MiB (+15.85)**, and browser JS
heap **8.13 MiB**. **Three browser renderer processes including spares** totalled
**407.75/172.22 MiB RSS/PSS**; that is neither just the noVNC renderer nor phone
RAM. Owner jobs/test-driver memory was separate. RSS double-counts shared pages;
PSS apportions them. A second real slow reader was bounded/detached.

Visibility events were **emulated**, disposal awaited, then the renderer was
**actually CDP-frozen/unfrozen**. This is not proof of phone OS lifecycle delivery
or freezing while attached. No new browser/native/soak/model test was run for
this portability/512-limit change. See [historical scope](desktop/TEST_RESULTS.md).
A small VPS must budget for its actual concurrent tools; there is no guaranteed
minimum-RAM promise or all-day leak guarantee from a four-minute run.

## Operations, backups, tests and licensing

- [Operations](docs/OPERATIONS.md): start/status/reload/stop, environment changes,
  frozen-release upgrades/rollback, safe backups and troubleshooting. Web restart
  preserves independent tmux jobs; explicit Stop, native X failure or reboot does not.
- `npm run backup` (after the private env-loading block) uses SQLite's online
  backup API; do not copy a live WAL database. Backups contain auth metadata and
  must remain private. No terminal transcript is stored by this app. Back up
  projects/CLI state separately with appropriate encryption/authorization.
- Isolated developer checks: `npm ci && npm run build`, `npm --prefix desktop ci`,
  `npm --prefix desktop run build`, `npm run test:publication`,
  `npm --prefix desktop test`, `npm --prefix desktop run test:limits`.
  Run in a disposable checkout, **never over live dist**. These scoped tests use
  fake Telegram/RFB, isolated test tmux/state, and no paid model/browser/native
  desktop invocation. Root is required for the root-to-Unix/opt-in test boundary.
  Browser/native tests are separate explicit opt-ins with [test prerequisites](desktop/tests/README.md).
- This publication adds **no permissive license for original application code**;
  the owner has not chosen one. See [LICENSING.md](LICENSING.md). noVNC changes
  remain MPL-2.0; retain upstream/vendor notices and provide corresponding patched
  source with redistributed desktop artifacts, not just a minified bundle.
