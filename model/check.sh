#!/usr/bin/env bash
# Run everystate with a memory ceiling, passing every argument through.
#
# The checker keeps each state it has seen in memory and has no option that
# bounds it, so a configuration whose state space has no bound grows until the
# machine swaps. On 2026-11-27 one such run reached 19.8 GB on a 32 GB machine,
# filled its 16 GB of swap, froze the desktop for two minutes, and ended only
# when the kernel's OOM killer chose it.
#
# EVERYSTATE_MEMORY sets the ceiling, 4G by default, in systemd's units
# (K, M, G). On Linux with a systemd user session, the run gets a scope of its
# own with no swap, so the kernel stops it at the ceiling before anything else
# slows down. Elsewhere a watchdog sums the resident size of the checker's whole
# process tree every half second and stops the tree past the ceiling. The npm
# `everystate` is a node launcher that runs the native binary as a child, and
# the child holds the states, so the launcher's own size says nothing (issue
# #263). EVERYSTATE_CAP=watchdog picks the watchdog on Linux too.
set -u
ES=${EVERYSTATE:-everystate}
LIMIT=${EVERYSTATE_MEMORY:-4G}

kib() {
  local n=${1%[KkMmGg]} unit=${1: -1}
  case $unit in
    K|k) echo "$n" ;;
    M|m) echo $((n * 1024)) ;;
    G|g) echo $((n * 1024 * 1024)) ;;
    *) echo $((${1} / 1024)) ;;
  esac
}
LIMIT_KIB=$(kib "$LIMIT")
if ! [[ $LIMIT_KIB =~ ^[0-9]+$ ]] || [ "$LIMIT_KIB" -le 0 ]; then
  echo "check.sh: EVERYSTATE_MEMORY=$LIMIT is not a size such as 512M or 4G" >&2
  exit 2
fi

over() {
  echo "check.sh: $ES passed the memory ceiling of $LIMIT and was stopped. The configuration's state space may have no bound. Raise EVERYSTATE_MEMORY only once you know it has one." >&2
  exit 137
}

if [ "${EVERYSTATE_CAP:-}" != watchdog ] && [ "$(uname -s)" = Linux ] && command -v systemd-run >/dev/null 2>&1 && systemd-run --user --scope --quiet true >/dev/null 2>&1; then
  systemd-run --user --scope --quiet -p MemoryMax="$LIMIT" -p MemorySwapMax=0 -p OOMPolicy=continue "$ES" "$@"
  code=$?
  [ "$code" -eq 137 ] && over
  exit "$code"
fi

# One line: the resident size in KiB of $1 and every process under it, then
# their PIDs, so the caller stops exactly the processes it measured. ps lists
# processes in no useful order, so the walk repeats until the tree stops
# growing. The watchdog's own ps, awk and sleep are children of this shell, not
# of the checker, so they never count.
tree() {
  ps -eo pid=,ppid=,rss= | awk -v root="$1" '
    { parent[$1] = $2; rss[$1] = $3 }
    END {
      if (!(root in parent)) exit
      tree[root] = 1
      do {
        grew = 0
        for (p in parent) if (!(p in tree) && (parent[p] in tree)) { tree[p] = 1; grew = 1 }
      } while (grew)
      total = 0
      list = ""
      for (p in tree) { total += rss[p]; list = list " " p }
      print total, list
    }'
}

# Stop the checker and everything under it. A launcher killed alone leaves the
# native binary running, with its memory, under init.
# shellcheck disable=SC2329  # the traps below call it
stop_tree() {
  local total pids
  read -r total pids < <(tree "$pid")
  # shellcheck disable=SC2086  # one PID per word
  kill "-$1" "$pid" $pids 2>/dev/null
}

"$ES" "$@" &
pid=$!
trap 'stop_tree TERM' INT TERM
trap 'stop_tree KILL' EXIT
while kill -0 "$pid" 2>/dev/null; do
  read -r total pids < <(tree "$pid")
  if [ -n "${total:-}" ] && [ "$total" -gt "$LIMIT_KIB" ]; then
    # shellcheck disable=SC2086  # one PID per word
    kill -9 $pids 2>/dev/null
    wait "$pid" 2>/dev/null
    trap - INT TERM EXIT
    over
  fi
  sleep 0.5
done
wait "$pid"
code=$?
trap - INT TERM EXIT
exit "$code"
