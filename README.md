# Bellwether

Bellwether lets a coding agent in [herdr](https://herdr.dev) start other agents and supervise them. The agent can watch, message, resume and retire each one, on this machine or on another. Every answer comes back to the session that asked.

## The problem it removes

Without it, a person copies prompts and replies between windows by hand. A parent agent has to guess whether a child finished, so it either polls or waits too long. When a child ends, its worktree and branch remain, or a person deletes them before checking that the work merged.

## Requirements

- herdr, with the parent agent running in one of its panes.
- Pi or Claude Code as the harness. Either one can be a parent or a child.
- Node 22.18 or newer, unless you install through Homebrew, which brings its own.

A child on a second machine needs more. Both machines need Bellwether, and the parent's machine needs a saved herdr profile for the other one. SSH must log in each way with a key and no prompt, under a host name that resolves. [docs/remote-machines.md](docs/remote-machines.md) lists each requirement.

## Install

Install the `bellwether` command, through Homebrew or through npm:

```sh
brew install elecnix/tap/bellwether
```

```sh
npm install -g @elecnix/bellwether
```

For Pi:

```sh
pi install npm:@elecnix/bellwether
```

For Claude Code, add the elecnix plugin marketplace and install the plugin from it, then start each parent session with the flag below:

```sh
claude plugin marketplace add elecnix/claude-plugins
claude plugin install bellwether@elecnix-plugins
```

```sh
claude --dangerously-load-development-channels plugin:bellwether@elecnix-plugins
```

Check the result:

```sh
bellwether doctor
```

[docs/install.md](docs/install.md) explains the flag and what to do when doctor fails.

## Update

Update each part you installed, on every machine that runs Bellwether:

```sh
brew upgrade bellwether                  # or: npm install -g @elecnix/bellwether
pi install npm:@elecnix/bellwether
```

For Claude Code, run `claude plugin marketplace update elecnix-plugins`, then `claude plugin update bellwether@elecnix-plugins`.

Then start your next session as usual. It replaces the daemon with one from the new install, and the sessions already open keep working until they end on their own:

```sh
bellwether doctor                        # says upgrade: finished once every session runs the new install
```

[docs/upgrading.md](docs/upgrading.md) says what happens while two versions share a machine, and what to do if the hand-over fails.

## Parts

herdr reports each agent's state, and Bellwether turns those reports into events for the parent. In Claude Code, Bellwether arrives as a channel, so Claude Code loads it only under the development-channel flag. One daemon per machine keeps the state, and every Pi or Claude Code session is a client of it. A child on another machine reaches its parent over SSH.

## Documentation

- [docs/tools.md](docs/tools.md): the tools a session gets, and the events a parent receives.
- [docs/recovery.md](docs/recovery.md): resuming and retiring a child, and handling a stuck or blocked one.
- [docs/remote-machines.md](docs/remote-machines.md): children on another machine.
- [docs/upgrading.md](docs/upgrading.md): updating several machines and protocol changes.
- [docs/releasing.md](docs/releasing.md): cutting a release, for maintainers.
- [AGENTS.md](AGENTS.md): how the code fits together, for anyone changing it.

## License

MIT
