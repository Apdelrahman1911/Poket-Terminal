#!/usr/bin/env bash
set -euo pipefail
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
source scripts/runtime-env.sh
export PT_DATA_DIR="${PT_DATA_DIR:-$PWD/.runtime/production}"
export PT_HOST="${PT_HOST:-127.0.0.1}"
export PT_PORT="${PT_PORT:-3000}"
exec python3 -I scripts/supervisor.py "$PT_DATA_DIR" node --max-old-space-size=96 dist/server/index.js
