#!/usr/bin/env bash
set -euo pipefail

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
node_bin="${CODEX_SCREENSHOT_NODE:-}"

if [[ -z "$node_bin" ]]; then
  codex_node="/Applications/Codex.app/Contents/Resources/cua_node/bin/node"
  if [[ -x "$codex_node" ]]; then
    node_bin="$codex_node"
  elif command -v node >/dev/null 2>&1; then
    node_bin="$(command -v node)"
  else
    echo "error: could not find node; set CODEX_SCREENSHOT_NODE" >&2
    exit 127
  fi
fi

exec "$node_bin" "$script_dir/screenshot.js" "$@"
