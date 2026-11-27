#!/usr/bin/env bash
# The ssh a relay check gives the parent's daemon in place of the real one.
# It calls the real ssh with the same options, and runs the remote command
# with a Bellwether home, daemon socket and install prefix of its own on the
# far machine, so the check never touches that machine's live daemon, its
# ~/.bellwether, or its global npm tree.
#
#   RELAY_CHECK_HOME         the Bellwether home on the far machine, such as /tmp/bwc-x/home
#   RELAY_CHECK_PREFIX       the npm prefix whose bin/bellwether runs there, such as /tmp/bwc-x/prefix
#   RELAY_CHECK_PREFIX_FILE  optional: a local file holding the prefix, read on every call,
#                            so a running check can switch the far end to another build
#   RELAY_CHECK_SSH          optional: the real ssh, default ssh
set -euo pipefail
: "${RELAY_CHECK_HOME:?set RELAY_CHECK_HOME to the Bellwether home on the far machine}"
prefix=${RELAY_CHECK_PREFIX:-}
if [[ -n ${RELAY_CHECK_PREFIX_FILE:-} && -s $RELAY_CHECK_PREFIX_FILE ]]; then prefix=$(<"$RELAY_CHECK_PREFIX_FILE"); fi
: "${prefix:?set RELAY_CHECK_PREFIX, or RELAY_CHECK_PREFIX_FILE, to the install prefix on the far machine}"
args=("$@")
command=${args[-1]}
unset 'args[-1]'
printf -v home %q "$RELAY_CHECK_HOME"
printf -v bin %q "$prefix/bin"
# $PATH stays escaped, so the far machine's shell expands its own PATH.
exec "${RELAY_CHECK_SSH:-ssh}" "${args[@]}" "env BELLWETHER_HOME=$home BELLWETHER_DAEMON_SOCKET=$home/daemon.sock PATH=$bin:\$PATH $command"
