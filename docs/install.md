# Installation

The [README](../README.md#install) has the commands. This page covers what each harness needs and how to read `bellwether doctor`.

## The command

Homebrew installs `bellwether` and `bellwether-mcp` from the `elecnix/tap` formula, along with its own Node. The npm route installs the same two commands and needs Node 22.18 or newer. To try the command without installing it:

```sh
npx -y @elecnix/bellwether doctor
```

## Pi

`pi install npm:@elecnix/bellwether` adds the extension, and Pi loads it at the next session start. When `pi list` shows Bellwether at a local checkout instead of the npm package, Pi keeps loading that checkout until you run the install command again.

This install is for a parent session. A pi child needs nothing in the host's pi settings. `agent_spawn` starts the child with `-e` pointing at the extension inside the installed package, so the child gets its tools on any machine with Bellwether installed. If the host's pi settings also list Bellwether, that copy registers nothing in the child, so each tool appears once.

An older copy in pi's settings has no such guard, and pi exits at startup when two extensions register the same tool. While pi's settings list one, a pi spawn refuses to start, and its error says to run `pi install npm:@elecnix/bellwether`.

## Plugin and channel

The plugin runs Bellwether's MCP server and declares it a channel, which carries child events.

It installs from the elecnix plugin marketplace, `elecnix/claude-plugins`, as `bellwether@elecnix-plugins`.

Claude Code channels are a research preview, and Claude Code loads a plugin's channel only when you start the session with this flag:

```sh
claude --dangerously-load-development-channels plugin:bellwether@elecnix-plugins
```

A marketplace install still needs the flag. An organization can put the plugin on its approved channel list in managed settings, and then `--channels plugin:bellwether@elecnix-plugins` loads it without the flag. [Probe 7](probes.md#7-starting-the-channel-with---channels-instead-of-the-development-flag) gives the details.

Without the flag, tools still work, but child events wait in the outbox and no turn starts.

Install the plugin for the sessions you start yourself. A Claude Code child that Bellwether starts gets its own MCP server from the spawn, so it works without a plugin or an `mcpServers` entry in your settings.

Bellwether gives each Claude Code child one set of tools, from its own server, which is the only server that holds its child id. The spawn turns the Bellwether plugin off for that child alone, in the settings file it passes with `--settings`.

In your user, local or project scope, a Bellwether server loses its name to the child's own config. A server under another name gets a stand-in that doesn't offer any tools. Your settings files stay as they are. The child's record says which servers the spawn kept out, and `bellwether doctor` prints a `tools claude-code` line that says the same for this machine.

A Claude Code child prints `server:bellwether · no MCP server configured with that name` under its channel banner. The line is wrong, because Claude Code has loaded the server. Claude Code checks a `server:` channel against the servers in its settings files only, and a child's server comes from `--mcp-config`, which that check doesn't read. `parent_report` and the other tools work in that child, and the parent gets its events. Bellwether can't remove the line without writing the child's server into your Claude Code settings, which it never does. The defect is Claude Code's, reported as [anthropics/claude-code#100865](https://github.com/anthropics/claude-code/issues/100865). To see it outside Bellwether, run `claude --mcp-config=cfg.json --dangerously-load-development-channels=server:probe` with a stdio server named `probe` in `cfg.json`: the line appears. Declare the same server in the folder's `.mcp.json` instead, and it doesn't.

A Claude Code child opens on two questions: whether to trust its folder, and whether to load the development channel. The spawn answers yes to both before it returns, for any folder the parent names. If a question is still on screen after 30 seconds, the spawn fails with an error that quotes it.

### Moving from the bellwether marketplace

Earlier, this repository was also a marketplace, and the plugin installed as `bellwether@bellwether`. Claude Code can no longer install from that marketplace, because this repository stopped declaring one. Remove it, which also uninstalls its plugin, and install from the elecnix marketplace:

```sh
claude plugin marketplace remove bellwether
claude plugin marketplace add elecnix/claude-plugins
claude plugin install bellwether@elecnix-plugins
```

Then start Claude Code with `plugin:bellwether@elecnix-plugins` after the flag, where you had `plugin:bellwether@bellwether`.

## Checking the install

```sh
bellwether doctor
```

Doctor lists the herdr socket, whether the herdr API answers, the Pi extension, the MCP entry point, the daemon, and every registered parent with its children. It fails when the Pi extension path doesn't resolve or the MCP entry lacks its executable bit. It also fails on a Bellwether copy in pi's settings that predates the guard against a second copy. A pi child would exit at startup there.

From version 0.1.5, doctor also prints the installed version and protocol and compares them with the running daemon's. From that version, `bellwether --version` prints the installed version alone.
