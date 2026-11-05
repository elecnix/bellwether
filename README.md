# Bellwether

Bellwether gives a coding agent in herdr tools to start another agent in a new herdr tab, of any kind herdr can start. When a child reports, goes idle, blocks, stalls or exits, the parent agent gets a fresh turn that says so. One herdr subscription streams each child state change to the parent.

The MVP covers Pi and Claude Code, each as a parent and as a child.

## Parts

A parent session runs an adapter: a Pi extension, or a Claude Code MCP channel server. Both adapters run the same Bellwether core.

- **herdr client.** Newline-delimited JSON on the herdr socket, one connection per request and one held open for the subscription. The subscription checks the `subscription_started` acknowledgement and buffers any event that arrives with it.
- **Registry.** One JSON file per parent session, under `~/.bellwether/parents/`. Each child record stores its name, kind, pane, tab, start time, last status, last `completion_seq` and transcript path. Bellwether writes the record before it asks herdr for anything, so a crash mid-spawn still says what it asked herdr for.
- **Watcher.** It subscribes to `pane.agent_status_changed` for each child pane, plus `pane.exited`, `pane.closed` and `pane.agent_detected`. On connect it subscribes first, then reads a snapshot on a second connection, then reconciles. A dropped subscription reconnects with backoff and takes a fresh snapshot, because herdr does not replay events.
- **Classifier.** It turns herdr states into child events, with a settle time for each. It is a pure function of state, clock and observation.
- **Outbox.** One pending entry per child, where a newer state replaces an older one. The receipt id in the entry marks it read once the parent's model context shows that id.

## Child events

| Event | Signal | Settle |
| -- | -- | -- |
| report | The child calls `parent_report`. | none |
| idle | herdr reports `idle` or `done` with a new `completion_seq`, and no report covered that turn. | 5 s |
| blocked | herdr reports `blocked`. | 3 s |
| stuck | herdr reports `working` or `unknown` and the child has been quiet past the threshold. | 10 min |
| exited | `pane.exited`, `pane.closed`, or herdr stops detecting the agent. | none |

## Tools

| Tool | Who gets it | What it does |
| -- | -- | -- |
| `agent_spawn` | any session | starts a child in a new tab |
| `agent_list` | any session | lists this session's children with status, age and unread events |
| `agent_read` | any session | returns a child's last assistant message, or its screen when you pass `lines` |
| `agent_send` | any session | prompts a child, or sends keys when herdr refuses a blocked one |
| `agent_stop` | any session | closes a child's tab, refusing a working child unless you pass `force` |
| `parent_report` | a child whose environment carries `BELLWETHER_PARENT` | sends `done`, `needs-input` or `progress` to the parent |

Bellwether sends input only to panes it started for this parent.

## Install

### Pi

```sh
pi install npm:@elecnix/bellwether
```

The package declares its extension under `pi.extensions`, so Pi loads it at the next session start.

### Claude Code

Add the marketplace, then install the plugin:

```text
/plugin marketplace add elecnix/bellwether
/plugin install bellwether@bellwether
```

Channels are a research preview. A plugin outside the organization allowlist needs the development flag when the session starts:

```sh
claude --dangerously-load-development-channels plugin:bellwether@bellwether
```

The plugin runs `bin/bellwether-mcp.js` as an MCP server and enables it as a channel, and that declaration is what delivers child events. Load the server as a plain MCP server and the tools arrive, with events waiting in the outbox.

The server speaks MCP over stdio, so each log line goes to stderr and stdout carries only the protocol. It exits when stdin closes, which keeps a leftover process from showing the session as listening.

### Check the install

```sh
bellwether doctor
```

It reports the herdr socket, the herdr API version, the Pi extension path, the MCP entry point and every registered parent with its children. A Pi extension path that does not resolve, or an MCP entry without its executable bit, fails the check.

## Environment

A child started by `agent_spawn` receives these variables in its tab:

| Variable | Meaning |
| -- | -- |
| `BELLWETHER_PARENT` | the parent session's registry id |
| `BELLWETHER_CHILD` | this child's record id |
| `BELLWETHER_CHILD_NAME` | this child's name |
| `BELLWETHER_DEPTH` | how many levels deep this child sits |
| `BELLWETHER_HARNESS` | `pi`, `claude-code`, or `other` |

## Layout

```
src/core/          herdr client, registry, watcher, classifier, outbox, spawn, report
src/integrations/  the tool list, shared by both adapters
src/integrations/pi/       the Pi extension
src/integrations/claude/   the Claude Code MCP channel server
bin/               the bellwether command
docs/              probe results and notes
test/unit/         tier 1: fake clock, in-memory registry
test/integration/  tier 2: a fake herdr socket, tier 3: a real isolated herdr server
```

## License

MIT
