#!/usr/bin/env bash
# Installs only the local helper. Does not pair Telegram or change agent policy.
set -euo pipefail
umask 077
[[ $EUID == 0 && $# == 1 && $1 == /* ]] || { echo 'Usage (root): scripts/install-agent-notify.sh /absolute/PT_DATA_DIR' >&2; exit 1; }
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
data=$(realpath -e -- "$1")
node=$(command -v node)
[[ -f "$root/dist/server/agent-notify-cli.js" && -d "$data" && $(stat -c '%u:%a' "$data") == '0:700' ]] || { echo 'Build first and use the private root-owned data directory.' >&2; exit 1; }
dest=/usr/local/bin/pocketterminal-notify
[[ ! -L "$dest" ]] || { echo 'Refusing a symlink.' >&2; exit 1; }
if [[ -e "$dest" ]] && ! grep -Fqx '# PocketTerminal managed agent notification helper v1' "$dest"; then
  echo 'Refusing to overwrite an unrelated command.' >&2; exit 1
fi
tmp=$(mktemp /usr/local/bin/.pocketterminal-notify.XXXXXX)
trap 'rm -f -- "$tmp"' EXIT
{
  printf '#!/usr/bin/env bash\n# PocketTerminal managed agent notification helper v1\n'
  printf 'export PT_NOTIFY_SOCKET=%q\nexec %q %q "$@"\n' "$data/agent-notify.sock" "$node" "$root/dist/server/agent-notify-cli.js"
} > "$tmp"
chmod 0700 "$tmp"
mv -T -- "$tmp" "$dest"
echo 'Installed root-only pocketterminal-notify; no credentials copied or agent jobs restarted.'
