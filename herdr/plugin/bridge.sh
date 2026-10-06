#!/usr/bin/env bash
# Lend this Herdr to iterate projects: one `iterate provide` for each line of the `targets` file in
# the plugin's config dir, kept running in the background (herdr/README.md). A Herdr startup hook is
# one-shot, so `start` detaches them and exits; each redials until `stop`.
#
#   bridge.sh start | stop | restart | status
set -u

ROOT="${HERDR_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
CONFIG_DIR="${HERDR_PLUGIN_CONFIG_DIR:-$HOME/.config/herdr/plugins/config/iterate-bridge}"
STATE_DIR="${HERDR_PLUGIN_STATE_DIR:-$HOME/.local/state/herdr/plugins/iterate-bridge}"
TARGETS="$CONFIG_DIR/targets"
mkdir -p "$CONFIG_DIR" "$STATE_DIR"

# Optional settings (NODE, CLI, HERDR_LABEL, HERDR_LOG_PATH), exported for the bridges.
# shellcheck disable=SC1091
[ -f "$CONFIG_DIR/config.sh" ] && . "$CONFIG_DIR/config.sh"
export HERDR_LABEL="${HERDR_LABEL:-Herdr on $(hostname -s)}"

log() { printf 'iterate-bridge: %s\n' "$*"; }

# `iterate`'s own shim runs pnpm's Node, which can be older than 22.18 and then cannot load a .ts
# file: run the CLI's entry point with a Node that can.
pick_node() {
  local candidate
  for candidate in "${NODE:-}" /opt/homebrew/bin/node /usr/local/bin/node "$(command -v node 2>/dev/null)"; do
    [ -x "$candidate" ] || continue
    "$candidate" -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 18) ? 0 : 1)' \
      && { echo "$candidate"; return 0; }
  done
  return 1
}

pick_cli() {
  local candidate
  for candidate in "${CLI:-}" \
    "$HOME/Library/pnpm/global/5/node_modules/iterate/bin/iterate.js" \
    "$HOME/.local/share/pnpm/global/5/node_modules/iterate/bin/iterate.js" \
    "$(npm root -g 2>/dev/null)/iterate/bin/iterate.js"; do
    [ -f "$candidate" ] && { echo "$candidate"; return 0; }
  done
  return 1
}

# The lines of `targets`: <iterate config> <project> [capability name, default jonas.herdr]
each_target() {
  local config project name
  [ -f "$TARGETS" ] || { log "no $TARGETS (copy plugin/targets.example)"; return 1; }
  while read -r config project name _; do
    case "$config" in '' | '#'*) continue ;; esac
    "$1" "$config" "$project" "${name:-jonas.herdr}"
  done <"$TARGETS"
}

alive() { # a pid file whose process runs
  local pid
  pid="$(cat "$1" 2>/dev/null)" || return 1
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

start_one() {
  local config="$1" project="$2" name="$3"
  local pidfile="$STATE_DIR/$config-$project.pid" logfile="$STATE_DIR/$config-$project.log"
  if alive "$pidfile"; then
    log "$config/$project already runs (pid $(cat "$pidfile"))"
    return 0
  fi
  local node cli key=""
  node="$(pick_node)" || { log "no Node 22.18 or later (set NODE in $CONFIG_DIR/config.sh)"; return 1; }
  cli="$(pick_cli)" || { log "no iterate CLI: pnpm add -g iterate@latest (or set CLI)"; return 1; }
  # a key of its own (iterate tokens create --never-expires) outlives the 30 days of `iterate login`
  [ -r "$CONFIG_DIR/$config.key" ] && key="$(cat "$CONFIG_DIR/$config.key")"
  (
    exec >>"$logfile" 2>&1
    [ -n "$key" ] && export ITERATE_BEARER_TOKEN="$key"
    while true; do
      "$node" "$cli" --config "$config" provide "$ROOT/src/herdr.ts" --name "$name" --project "$project"
      echo "$(date -u +%FT%TZ) iterate provide ended (exit $?); again in 30 s"
      sleep 30
    done
  ) &
  echo $! >"$pidfile"
  log "started $config/$project as itx.$name (pid $!, log $logfile)"
}

stop_one() {
  local pidfile="$STATE_DIR/$1-$2.pid" pid
  if alive "$pidfile"; then
    pid="$(cat "$pidfile")"
    pkill -P "$pid" 2>/dev/null # the `iterate provide` under the loop
    kill "$pid" 2>/dev/null
    log "stopped $1/$2 (was pid $pid)"
  else
    log "$1/$2 does not run"
  fi
  rm -f "$pidfile"
}

status_one() {
  local pidfile="$STATE_DIR/$1-$2.pid" logfile="$STATE_DIR/$1-$2.log"
  if alive "$pidfile"; then
    log "$1/$2 runs (pid $(cat "$pidfile")); last log line: $(tail -n 1 "$logfile" 2>/dev/null)"
  else
    log "$1/$2 does not run; last log line: $(tail -n 1 "$logfile" 2>/dev/null)"
  fi
}

case "${1:-status}" in
  start) each_target start_one ;;
  stop) each_target stop_one ;;
  restart) each_target stop_one; sleep 1; each_target start_one ;;
  status) each_target status_one ;;
  *) echo "usage: bridge.sh start | stop | restart | status" >&2; exit 2 ;;
esac
