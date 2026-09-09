# Optional desktop deployment and rollback

First finish [PocketTerminal installation](../README.md) with private password,
loopback backend and working exact-origin HTTPS. Tested OS: Ubuntu 24.04 LTS
x86_64; packages/features on other systems are not promised. These are explicit
fresh-host **operator** actions, never an automatic web/browser command.

## Build and provision (does not start anything)

```bash
cd /opt/pocketterminal
npm --prefix desktop ci
npm --prefix desktop run build
python3 -I desktop/scripts/provision.py --packages \
  --client desktop/.runtime/candidates/client/client
```

The provisioner simulates signed-repository apt installs first, and refuses a
transaction needing upgrades/removals. If it refuses, inspect/resolve package
state as the operator; do not remove the refusal. Native packages include
TigerVNC, minimal XFCE components, Xauthority, D-Bus and fonts, without recommends.
It checks required Xtigervnc Unix-socket/geometry/clipboard options.

It creates three dedicated password-locked `nologin` accounts (`pocketdesktop`,
`pocketdesktop-test`, `pocketdesktop-browser`) and private 0700 homes. Test accounts
are reserved for isolated acceptance, not automatically launched. None receives
sudo/supplementary owner access. A conflicting unlocked/unexpected account causes
refusal rather than takeover. It installs immutable root-owned helpers and the
built client to a content-addressed `/opt/pocketdesktop/releases/<digest>`, sets
`/opt/pocketdesktop/current`, and links `/usr/local/bin/pocketdesktop` to its fixed
root-only CLI. No web dist, service restart or provider boot config is changed.

Keep the candidate's complete patched `source/` plus patch/hash/license notices
with any redistributed client; the provisioner copies runtime assets only, not
a public corresponding-source endpoint. See [MPL notes](patches/README.md).

## Persistent web opt-in (recommended)

Leave `PT_DESKTOP_ENABLED` **unset** in the web service environment. Write the
narrow root-owned opt-in atomically:

```bash
install -d -o root -g root -m 0700 /etc/pocketdesktop
umask 077
printf '%s\n' '{"enabled":true,"autoStart":false}' > /etc/pocketdesktop/gateway.json.new
chown root:root /etc/pocketdesktop/gateway.json.new
chmod 0600 /etc/pocketdesktop/gateway.json.new
mv -T /etc/pocketdesktop/gateway.json.new /etc/pocketdesktop/gateway.json
systemctl reload pocketterminal
```

Only `{enabled:boolean,autoStart:boolean}` is accepted; absence, unsafe ownership,
permissions, symlinks, oversized/extra/malformed fields disable Desktop. This
file is read **on every Node start**, not only by the long-lived Python supervisor.
The recommended `autoStart:false` starts GUI only after authenticated **Connect**
or an explicit root CLI command. `autoStart:true` explicitly opts into one native
start attempt per Node start (including boot); no automatic job/history restore.

If the supervisor already inherited `PT_DESKTOP_ENABLED=0`, remove it and use a
controlled **supervisor restart**, not HUP. `PT_DESKTOP_ENABLED=1` explicitly forces
gateway enable; changing a shell/file export does not change the supervisor's old
environment. Keep the same host/data settings and preserve independent tmux jobs.
There is no need to restart native GUI processes to activate/reload the gateway.
For the non-systemd launcher see [operations](../docs/OPERATIONS.md).

## Start, use, status and stop

```bash
pocketdesktop status
pocketdesktop start                 # root CLI; idempotent, fixed profile only
# Intentional GUI shutdown, not routine web reload:
# pocketdesktop stop --confirm-desktop-apps
```

Open the terminal site's **Desktop** link or `/desktop/`, sign in with the same
owner password, and press Connect. Disconnect/hide/logout closes only viewers;
GUI apps remain running. The private native tmux/subreaper service is independent
of Node. No idle shutdown. Concurrent starts serialize; identity/pidfd checks
protect scoped cleanup against PID reuse. Restart/crash of X or explicit stop
ends GUI apps; a reboot cannot preserve them. Files in the GUI home persist;
session restore is intentionally disabled. Test profiles must never share the
real desktop UID or owner project/auth data.

Native display is `:71`, 1280×720×24, max 15 fps. RFB is **Unix-only** at
`/run/pocketdesktop/rfb.sock` (0600 in 0700), with `-rfbport -1`; X11 has no TCP
listener and requires private Xauthority. Internal RFB `SecurityTypes=None` is
permitted only behind Unix permissions and the authenticated bounded gateway.
Never expose 5900/5971/6000/6071/9990, run websockify publicly, use `xhost +`, turn
off Xauthority or disable browser/renderer/network sandboxing or web security.

The GUI account cannot traverse `/root`. Do not change that. Use its own home or
an explicitly shared **non-secret** folder with minimum necessary permissions;
never share root credentials/config or grant sudo. Its environment is rebuilt
from an allowlist, without root provider/API/SSH secrets.

### Optional Chrome/GUI applications

No heavyweight browser is required or installed by the helper. If desired, obtain
Ubuntu-compatible **Google Chrome stable** from its official signed download/
repository instructions, install it separately as root, then launch it normally
from an XFCE terminal/menu **as `pocketdesktop`**, e.g. `google-chrome-stable`.
Do not launch a root GUI/browser or add `--no-sandbox`, sandbox-disabling, site
isolation or web-security bypass flags. Chrome's package licensing is separate.
Vendor pointer: [Google Chrome](https://www.google.com/chrome/) and
[Linux installation help](https://support.google.com/chrome/answer/95346).
For an owner who chooses the official Ubuntu x86_64 stable `.deb`:

```bash
# Optional operator install only; NOT run by publication tests/provisioning.
install -d -m 0700 /root/pocketterminal-setup
cd /root/pocketterminal-setup
curl --fail --location --proto '=https' --tlsv1.2 \
  -o google-chrome-stable_current_amd64.deb \
  https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb || exit 1
# Review the vendor source/package; this adds Google's package/update integration.
apt-get install ./google-chrome-stable_current_amd64.deb
# Then, INSIDE the non-root XFCE terminal (not this root SSH shell):
# google-chrome-stable
```


`child_limits` sets **RLIMIT_NPROC=(512,512)**, NOFILE=1024 and CORE=0. Linux NPROC
counts **threads across the real UID**, not just processes. Sandboxed Chrome 153
failed to create threads at 256 and succeeded at 512 in a separate coordinator
check. This ceiling **does not preallocate/reserve RAM**; sites, renderers, GPU
processes and builds add workload-dependent memory. It is not a promise that all
sites fit or a replacement for RAM capacity planning.

Existing GUI processes retain their inherited limits until an authorized
operator changes those particular processes' limits or intentionally restarts
the GUI (which ends apps). Updating the helper file alone does not change live
limits. This publication performs neither action; no Chrome/native tests were
run for it. All Chrome/renderer/network sandboxes remain enabled.

## Upgrade / rollback without stopping owner jobs

Build reviewed new client/helper source in a disposable checkout first. Record
`readlink -f /opt/pocketdesktop/current` as the previous immutable release before
provisioning the new one (omit `--packages` when packages are already ready).
The new pointer affects new helper starts and served assets, not the code already
executing in an existing GUI. Routine web reloads preserve existing GUI and
terminal jobs. Applying native code to a running GUI requires a separate explicit
stop/start, with an app-loss warning; do not imply an HUP applies native limits.

To hide/disconnect Desktop without stopping GUI/apps, atomically set
`{"enabled":false,"autoStart":false}` in the same secure file, then reload Node.
Ensure no inherited `PT_DESKTOP_ENABLED=1` override remains; if it does, remove it
and deliberately restart only the web supervisor. Other terminal jobs persist.

To roll back native/client code, point `/opt/pocketdesktop/current.new` at the
recorded previous **root-owned reviewed release**, then atomically
`mv -T /opt/pocketdesktop/current.new /opt/pocketdesktop/current`. Retain both
release trees and corresponding source; do not overwrite immutable files.
Reload the gateway if required; do not stop GUI without the owner's explicit
app-loss consent. To intentionally stop GUI, use the exact confirmed CLI above,
never a process-name/UID guess or all-tmux kill. Removing the gateway opt-in or
rolling web source back does not require package/account removal.
