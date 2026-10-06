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

# A startup hook's output is only in `herdr plugin log list`, which nobody reads at startup: what
# needs the user is also shown as a notification.
fail() {
  log "$*"
  "${HERDR_BIN_PATH:-herdr}" notification show "iterate bridge" --body "$*" >/dev/null 2>&1 || true
}

# `iterate`'s own shim can run an older Node than 22.18, which cannot load a .ts file: run the CLI's
# entry point with a Node that can.
pick_node() {
  local candidate
  for candidate in "${NODE:-}" /opt/homebrew/bin/node /usr/local/bin/node "$(command -v node 2>/dev/null)"; do
    [ -x "$candidate" ] || continue
    "$candidate" -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 18) ? 0 : 1)' \
      && { echo "$candidate"; return 0; }
  done
  return 1
}

# CLI_CMD: how to run the iterate CLI under that Node. An installed copy (CLI, then a global one), or
# else `npx iterate`, so nothing has to be installed first (the first run downloads it).
resolve_cli() {
  local node="$1" candidate npx
  for candidate in "${CLI:-}" \
    "$HOME/Library/pnpm/global/5/node_modules/iterate/bin/iterate.js" \
    "$HOME/.local/share/pnpm/global/5/node_modules/iterate/bin/iterate.js" \
    "$(npm root -g 2>/dev/null)/iterate/bin/iterate.js"; do
    [ -f "$candidate" ] && { CLI_CMD=("$node" "$candidate"); return 0; }
  done
  npx="$(dirname "$node")/npx"
  [ -x "$npx" ] || npx="$(command -v npx 2>/dev/null)"
  [ -n "$npx" ] || return 1
  CLI_CMD=(env "PATH=$(dirname "$node"):$PATH" "$npx" --yes iterate)
}

# The lines of `targets`: <iterate config> <project> [capability name, default jonas.herdr]
each_target() {
  local config project name
  [ -f "$TARGETS" ] || return 1
  while read -r config project name _; do
    case "$config" in '' | '#'*) continue ;; esac
    "$1" "$config" "$project" "${name:-jonas.herdr}"
  done <"$TARGETS"
}

# The first run: a `targets` file with nothing active, to edit.
first_run() {
  [ -f "$TARGETS" ] && return 0
  sed 's/^\([^#[:space:]]\)/# \1/' "$ROOT/plugin/targets.example" >"$TARGETS"
  fail "first run: set the iterate project to lend this Herdr to in $TARGETS, then run the restart action (README: As a Herdr plugin)"
  return 1
}

alive() { # a pid file whose process runs
  local pid
  pid="$(cat "$1" 2>/dev/null)" || return 1
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

# After `iterate provide` ends: if what it wrote this run says the sign-in is over (every such error
# ends in "Run `iterate login` ..."), say so, at most once in 12 hours for a target. $4 is the log's
# line count before the run, so older lines never count.
warn_login() {
  local config="$1" project="$2" logfile="$3" before="$4"
  tail -n +"$((before + 1))" "$logfile" | grep -q 'iterate login' || return 0
  local stamp="$STATE_DIR/$config-$project.login-warned"
  [ -z "$(find "$stamp" -mmin -720 2>/dev/null)" ] || return 0
  touch "$stamp"
  fail "$config's sign-in has ended: run  iterate --config $config login  (the lend starts by itself afterwards)"
}

start_one() {
  local config="$1" project="$2" name="$3"
  local pidfile="$STATE_DIR/$config-$project.pid" logfile="$STATE_DIR/$config-$project.log"
  if alive "$pidfile"; then
    log "$config/$project already runs (pid $(cat "$pidfile"))"
    return 0
  fi
  local node key=""
  node="$(pick_node)" || { fail "needs Node 22.18 or later: install it, or set NODE in $CONFIG_DIR/config.sh"; return 1; }
  resolve_cli "$node" || { fail "needs the iterate CLI: install Node's npm (for npx) or run: npm install -g iterate"; return 1; }
  # a key of its own (iterate tokens create --never-expires) outlives the 30 days of `iterate login`
  [ -r "$CONFIG_DIR/$config.key" ] && key="$(cat "$CONFIG_DIR/$config.key")"
  # an unknown config does not start; not signed in still starts, and connects by itself afterwards
  local check
  check="$("${CLI_CMD[@]}" --config "$config" config get 2>&1)"
  case "$check" in
    *error:*) fail "iterate config $config: $(printf '%s\n' "$check" | sed -n 's/^error: *//p' | head -n 1 | cut -c1-200)"; return 1 ;;
  esac
  if [ -z "$key" ] && ! printf '%s' "$check" | grep -q 'hasToken: true'; then
    fail "$config is not signed in: run  iterate --config $config login  (the lend starts by itself afterwards)"
    touch "$STATE_DIR/$config-$project.login-warned"
  fi
  (
    exec >>"$logfile" 2>&1
    [ -n "$key" ] && export ITERATE_BEARER_TOKEN="$key"
    while true; do
      before="$(wc -l <"$logfile" | tr -d ' ')"
      "${CLI_CMD[@]}" --config "$config" provide "$ROOT/src/herdr.ts" --name "$name" --project "$project"
      echo "$(date -u +%FT%TZ) iterate provide ended (exit $?); again in 30 s"
      warn_login "$config" "$project" "$logfile" "$before"
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
  rm -f "$pidfile" "$STATE_DIR/$1-$2.login-warned"
}

status_one() {
  local pidfile="$STATE_DIR/$1-$2.pid" logfile="$STATE_DIR/$1-$2.log"
  if alive "$pidfile"; then
    log "$1/$2 runs (pid $(cat "$pidfile")); last log line: $(tail -n 1 "$logfile" 2>/dev/null)"
  else
    log "$1/$2 does not run; last log line: $(tail -n 1 "$logfile" 2>/dev/null)"
  fi
}

start() { first_run && { each_target start_one || true; }; }
case "${1:-status}" in
  start) start ;;
  stop) each_target stop_one ;;
  restart) each_target stop_one; sleep 1; start ;;
  status) each_target status_one ;;
  *) echo "usage: bridge.sh start | stop | restart | status" >&2; exit 2 ;;
esac
