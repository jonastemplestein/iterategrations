#!/bin/sh
# The LaunchAgent's entry point: lend this computer's Herdr to the iterate project as itx.jonas.herdr.
# The key lives outside git, in a file only this user can read (herdr/README.md#unattended).
set -eu
key_file="$HOME/.config/herdr-iterate-bridge/token"
[ -r "$key_file" ] || { echo "herdr-iterate-bridge: no key at $key_file" >&2; exit 78; }
ITERATE_BEARER_TOKEN="$(cat "$key_file")"
export ITERATE_BEARER_TOKEN
here="$(cd "$(dirname "$0")/.." && pwd)"
# `iterate`'s own shim runs its pnpm-managed Node, which can be older than 22.18 and then cannot load
# a .ts file: run the CLI's entry point with this Node.
node="${HERDR_BRIDGE_NODE:-/opt/homebrew/bin/node}"
cli="${HERDR_BRIDGE_CLI:-$HOME/Library/pnpm/global/5/node_modules/iterate/bin/iterate.js}"
exec "$node" "$cli" provide "$here/src/herdr.ts" --name jonas.herdr --project "${HERDR_BRIDGE_PROJECT:-iterate}"
