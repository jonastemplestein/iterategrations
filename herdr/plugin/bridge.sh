#!/usr/bin/env bash
# Lend this Herdr to iterate minds: one `iterate provide` for each line of the `targets` file in the
# plugin's config dir, kept running in the background (herdr/README.md). A bridge uses this
# computer's own sign-in to the mind (`iterate login <address>`). A line that ends in `key` gives its
# bridge a key of its own instead (`--key`), which may do less: a member of the mind allows it once.
# A Herdr startup hook is one-shot, so `start` detaches them and exits; each redials until `stop`.
#
#   bridge.sh start | stop | restart | status
set -u

ROOT="${HERDR_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
CONFIG_DIR="${HERDR_PLUGIN_CONFIG_DIR:-$HOME/.config/herdr/plugins/config/iterate-bridge}"
STATE_DIR="${HERDR_PLUGIN_STATE_DIR:-$HOME/.local/state/herdr/plugins/iterate-bridge}"
TARGETS="$CONFIG_DIR/targets"
mkdir -p "$CONFIG_DIR" "$STATE_DIR"
# The iterate CLI started inside a checkout of iterate runs that checkout's copy instead of itself:
# every CLI run here starts in the state dir, which is in none.
cd "$STATE_DIR" || exit 1

KEYS_DIR="$CONFIG_DIR/keys"
# Optional settings (NODE, CLI, HERDR_LABEL, HERDR_LOG_PATH), exported for the bridges.
# shellcheck disable=SC1091
[ -f "$CONFIG_DIR/config.sh" ] && . "$CONFIG_DIR/config.sh"
export HERDR_LABEL="${HERDR_LABEL:-Herdr on $(hostname -s)}"
export HERDR_LOG_PATH="${HERDR_LOG_PATH:-/integrations/herdr/primary}"

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

# CLI_CMD: how to run the iterate CLI under that Node. An installed copy (CLI, then a global one)
# that knows a mind (`provide --mind`; an older copy speaks to the old hosted platform alone), or
# else `npx iterate@latest`, so nothing has to be installed first (the first run downloads it).
resolve_cli() {
  local node="$1" candidate npx
  for candidate in "${CLI:-}" \
    "$HOME/Library/pnpm/global/5/node_modules/iterate/bin/iterate.js" \
    "$HOME/.local/share/pnpm/global/5/node_modules/iterate/bin/iterate.js" \
    "$(npm root -g 2>/dev/null)/iterate/bin/iterate.js"; do
    [ -f "$candidate" ] || continue
    "$node" "$candidate" provide --help 2>/dev/null | grep -q -- '--mind' \
      && { CLI_CMD=("$node" "$candidate"); return 0; }
  done
  npx="$(dirname "$node")/npx"
  [ -x "$npx" ] || npx="$(command -v npx 2>/dev/null)"
  [ -n "$npx" ] || return 1
  CLI_CMD=(env "PATH=$(dirname "$node"):$PATH" "$npx" --yes iterate@latest)
}

# The lines of `targets`: <the mind's address> [capability name, default jonas.herdr] [key]
each_target() {
  local mind name how
  [ -f "$TARGETS" ] || return 1
  while read -r mind name how _; do
    case "$mind" in '' | '#'*) continue ;; esac
    case "$mind" in
      *.*) ;;
      *) fail "$TARGETS: \"$mind\" is no mind's address (a line is now: <address> [name] [key], e.g. example.com jonas.herdr)"; continue ;;
    esac
    [ "$name" = key ] && { name=""; how=key; }
    "$1" "$mind" "${name:-jonas.herdr}" "${how:-}"
  done <"$TARGETS"
}

# The first run: a `targets` file with nothing active, to edit.
first_run() {
  [ -f "$TARGETS" ] && return 0
  sed 's/^\([^#[:space:]]\)/# \1/' "$ROOT/plugin/targets.example" >"$TARGETS"
  fail "first run: set the mind to lend this Herdr to in $TARGETS, then run the restart action (README: As a Herdr plugin)"
  return 1
}

alive() { # a pid file whose process runs
  local pid
  pid="$(cat "$1" 2>/dev/null)" || return 1
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

# What a run printed that a person must act on, said at most once in 12 hours for a target. $3 is the
# log's line count before the run, so older lines never count.
#   - with a key: `iterate provide` prints the link to the mind's own page and waits for a member;
#   - with a sign-in: every error of a sign-in that is missing or over names `iterate login`.
warn() {
  local mind="$1" logfile="$2" before="$3" link said
  said="$(tail -n +"$((before + 1))" "$logfile")"
  link="$(printf '%s\n' "$said" | grep -o 'https://[^ ]*/keys/enrol[^ ]*' | head -n 1)"
  [ -n "$link" ] || printf '%s\n' "$said" | grep -q 'iterate login' || return 0
  local stamp="$STATE_DIR/$mind.warned"
  [ -z "$(find "$stamp" -mmin -720 2>/dev/null)" ] || return 0
  touch "$stamp"
  if [ -n "$link" ]; then
    printf '%s\n' "$link" >"$STATE_DIR/$mind.allow-link"
    fail "$mind: a member allows this Herdr's key once. Open the link in $STATE_DIR/$mind.allow-link and press Allow (the lend starts by itself afterwards)"
  else
    fail "$mind: this computer is not signed in. Run  iterate login $mind  (the lend starts by itself afterwards)"
  fi
}

start_one() {
  local mind="$1" name="$2" how="$3"
  local pidfile="$STATE_DIR/$mind.pid" logfile="$STATE_DIR/$mind.log"
  if alive "$pidfile"; then
    log "$mind already runs (pid $(cat "$pidfile"))"
    return 0
  fi
  local node
  node="$(pick_node)" || { fail "needs Node 22.18 or later: install it, or set NODE in $CONFIG_DIR/config.sh"; return 1; }
  resolve_cli "$node" || { fail "needs the iterate CLI: install Node's npm (for npx) or run: npm install -g iterate"; return 1; }
  local with=()
  if [ "$how" = key ]; then
    mkdir -p "$KEYS_DIR" && chmod 700 "$KEYS_DIR"
    # the key may lend the one name, and add events under the stream's folder alone
    with=(--key "$KEYS_DIR/$mind.key" --paths "$(dirname "$HERDR_LOG_PATH")/")
  fi
  (
    exec >>"$logfile" 2>&1
    while true; do
      before="$(wc -l <"$logfile" | tr -d ' ')"
      "${CLI_CMD[@]}" provide "$ROOT/src/herdr.ts" --name "$name" --mind "$mind" ${with[@]+"${with[@]}"} &
      provide=$!
      # a key's link is printed at once, and `provide` then waits 15 minutes for the member
      sleep 20
      warn "$mind" "$logfile" "$before"
      wait "$provide"
      echo "$(date -u +%FT%TZ) iterate provide ended (exit $?); again in 30 s"
      warn "$mind" "$logfile" "$before"
      sleep 30
    done
  ) &
  echo $! >"$pidfile"
  log "started $mind as itx.$name${how:+ with a key of its own} (pid $!, log $logfile)"
}

stop_one() {
  local pidfile="$STATE_DIR/$1.pid" pid
  if alive "$pidfile"; then
    pid="$(cat "$pidfile")"
    pkill -P "$pid" 2>/dev/null # the `iterate provide` under the loop
    kill "$pid" 2>/dev/null
    log "stopped $1 (was pid $pid)"
  else
    log "$1 does not run"
  fi
  rm -f "$pidfile" "$STATE_DIR/$1.warned"
}

status_one() {
  local pidfile="$STATE_DIR/$1.pid" logfile="$STATE_DIR/$1.log"
  if alive "$pidfile"; then
    log "$1 runs (pid $(cat "$pidfile")); last log line: $(tail -n 1 "$logfile" 2>/dev/null)"
  else
    log "$1 does not run; last log line: $(tail -n 1 "$logfile" 2>/dev/null)"
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
