# Bellwether

Bellwether gives a coding agent in herdr tools to start another agent in a new herdr tab, of any kind herdr can start. When a child reports, goes idle, blocks, stalls or exits, the parent session gets a new turn that says so. The parent calls no herdr command and polls nothing.

The MVP covers Pi and Claude Code, each as a parent and as a child.

## Parts

A parent session runs an adapter: a Pi extension, or a Claude Code MCP channel server. The adapter holds the Bellwether core.

- **herdr client.** Newline-delimited JSON on the herdr socket, one connection per request and one held open for the subscription. The subscription checks the `subscription_started` acknowledgement and buffers any event that arrives with it.
- **Registry.** One JSON file per parent session, under `~/.bellwether/parents/`. Every child record carries its name, kind, pane, tab, start time, last status, last `completion_seq` and transcript path. Bellwether writes the record before it asks herdr for anything, so a crash mid-spawn still says what was asked for.
- **Watcher.** It subscribes to `pane.agent_status_changed` for each child pane, plus `pane.exited`, `pane.closed` and `pane.agent_detected`. On connect it subscribes first, then reads a snapshot on a second connection, then reconciles. A dropped subscription reconnects with backoff and takes a fresh snapshot, because herdr does not replay events.
- **Classifier.** It turns herdr states into child events, with a settle time for each. It is a pure function of state, clock and observation.
- **Outbox.** One pending entry per child, where a newer state replaces an older one. The receipt id in the entry marks it read once the id reaches the parent's model context.

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
| `agent_read` | any session | returns a child's last assistant message, or its screen when given `lines` |
| `agent_send` | any session | prompts a child, or sends keys when herdr refuses a blocked one |
| `agent_stop` | any session | closes a child's tab, refusing a working child unless given `force` |
| `parent_report` | a child whose environment carries `BELLWETHER_PARENT` | sends `done`, `needs-input` or `progress` to the parent |

Bellwether sends input only to panes it started for this parent.

## Install

```sh
pi install npm:@elecnix/bellwether
```

For Claude Code, start the session with the development channel:

```sh
claude --dangerously-load-development-channels server:bellwether
```

Check the plumbing with `bellwether doctor`. It reports the herdr socket, the herdr API version and every registered parent with its children.

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
