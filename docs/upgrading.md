# Upgrading

Bellwether reaches a machine through three installs, and each one updates on its own: the `bellwether` command, the Pi extension and the Claude Code plugin. A machine can use any mix of them.

## Order on each machine

1. `brew upgrade bellwether` where the machine uses the tap. Without Homebrew, run `npm install -g @elecnix/bellwether`. On a machine you reach by SSH, `command -v brew` tells you which one applies.

2. `pi install npm:@elecnix/bellwether` for the Pi extension, which Homebrew doesn't touch. It also points Pi back at the npm package when `pi list` shows a local checkout. Pi loads the new extension at the next session start.

3. `claude plugin marketplace update elecnix-plugins`, then `claude plugin update bellwether@elecnix-plugins`. The marketplace installs the plugin from this repository's default branch, not from npm.

4. `bellwether drain`. Each open session keeps a connection to the running daemon, so the daemon would keep its old code until it goes idle. Drain lets it finish its current calls and exit. Each session reconnects within a second and starts a daemon from its own install, so restart every session. Then the new daemon comes from the new install.

5. `bellwether doctor`, to compare the installed version with the running daemon's.

`bellwether drain` and the version line in doctor come with 0.1.5. The drain command also stops a 0.1.4 daemon.

A parent's daemon connects to a child on another machine over SSH, and the far end runs `bellwether relay-bridge`. Update both machines before a remote child reports across a protocol change. Protocol 4 changes the relay exchange, so a 0.1.x machine on either end can't take part until it updates. Until then, `bellwether doctor` on the parent's machine shows that machine as `reconnecting`, with the error from the far end.

## Daemon protocol changes

A release can change the protocol that sessions speak to the daemon. Which side updated first decides what a person sees:

- **A newer session meets an older daemon.** The session drains it and starts its own. The old daemon finishes its current calls before it exits, so every call gets its answer.
- **An older session meets a newer daemon.** Every tool call from that session fails with an error that asks you to update the install, until the session restarts. A child started before the upgrade runs its MCP server from the old install, so its `parent_report` fails the same way. The parent still receives its herdr status events.
- **No session has updated.** The old daemon keeps running until a session or `bellwether drain` replaces it.

To recover a child that still has to report, stop it and resume it with `agent_spawn` and `resume`, which starts it on the new install.

When the protocol stays the same, sessions reconnect to the new daemon after `bellwether drain` without an error.

## A build npm hasn't published

To run a commit ahead of the next release, build its tarball and install that. Don't install from a git URL. `npm install -g github:elecnix/bellwether#main` fails on an empty prefix: npm builds the clone with config from the global prefix, so the build finds no `tsgo` and exits 127.

Over an existing install, the same command stops earlier with `ENOTEMPTY` on the installed package's directory, and leaves that package as it was. Running `npm uninstall -g` first doesn't help. [#57](https://github.com/elecnix/bellwether/issues/57) has the details.

```sh
git clone --depth 1 https://github.com/elecnix/bellwether.git && cd bellwether
npm ci && npm run build && npm install -g "$(npm pack --silent)"
```

A release installs from the npm registry and doesn't need this. It installs over the version already there, with no uninstall first.
