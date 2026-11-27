# Installation

The [README](../README.md#install) has the commands. This page covers what each harness needs and how to read `bellwether doctor`.

## The command

Homebrew installs `bellwether` and `bellwether-mcp` from the `elecnix/tap` formula, along with its own Node. The npm route installs the same two commands and needs Node 22.18 or newer. To try the command without installing it:

```sh
npx -y @elecnix/bellwether doctor
```

## Pi

`pi install npm:@elecnix/bellwether` adds the extension, and Pi loads it at the next session start. When `pi list` shows Bellwether at a local checkout instead of the npm package, Pi keeps loading that checkout until you run the install command again.

## Plugin and channel

The plugin runs Bellwether's MCP server and declares it a channel, which carries child events.

Claude Code channels are a research preview, and Claude Code loads a plugin's channel only when you start the session with this flag:

```sh
claude --dangerously-load-development-channels plugin:bellwether@bellwether
```

A marketplace install still needs the flag. An organization can put the plugin on its approved channel list in managed settings, and then `--channels plugin:bellwether@bellwether` loads it without the flag. [Probe 7](probes.md#7-starting-the-channel-with---channels-instead-of-the-development-flag) gives the details.

Without the flag, tools still work, but child events wait in the outbox and no turn starts.

Install the plugin for the sessions you start yourself. A Claude Code child that Bellwether starts gets its own MCP server from the spawn, so it works without a plugin or an `mcpServers` entry in your settings. Children ignore a `bellwether` entry that is already there.

A Claude Code child opens on two questions: whether to trust its folder, and whether to load the development channel. The spawn answers yes to both before it returns, for any folder the parent names. If a question is still on screen after 30 seconds, the spawn fails with an error that quotes it.

## Checking the install

```sh
bellwether doctor
```

Doctor lists the herdr socket, whether the herdr API answers, the Pi extension, the MCP entry point, the daemon, and every registered parent with its children. It fails when the Pi extension path doesn't resolve or the MCP entry lacks its executable bit.

From version 0.1.5, doctor also prints the installed version and protocol and compares them with the running daemon's. From that version, `bellwether --version` prints the installed version alone.
