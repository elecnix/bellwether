# Working in this repo

Bellwether is the agent-supervision tool described in the design at `/Users/nicolas/design/bellwether.html`. Read that first. It carries the decisions, the references and the phase plan.

## Gates

Run these before a pull request. CI runs the same commands.

```sh
npm run typecheck      # tsgo over src, test, bin
npm test               # tier 1 unit, then tier 2 and 3 integration
npm run doctor         # bellwether doctor against the live herdr
```

Prose in Markdown files runs through Vale. The rules are the `ai-tells`, `ai-tells-experimental` and `noslop` packs. Read `/Users/nicolas/.agents/skills/vale-prose-rules/SKILL.md` before writing docs, a pull request body or a ticket.

## Rules that are not style

- **A session talks to the daemon, not to herdr.** The daemon reads the herdr subscription and stores the registry and outbox for every session on the machine. A tool call from an adapter goes to the daemon, and the daemon sends the adapter its events.
- **Never poll herdr for status.** Status arrives on `events.subscribe`. The only timers are the classifier's settle times and the stuck threshold.
- **Subscribe before the snapshot.** herdr does not replay events, so a subscription opened after a snapshot misses whatever happened between the two.
- **Write the registry record before `tab.create`.** A crash mid-spawn must still leave a trace.
- **Pass the brief through a file.** Each spawn writes it to `~/.bellwether/prompts/<child id>.md` with mode 0600, and the harness gets one line that points at it. herdr refuses an argument with a line break, and a command line shows in `ps`. A spawn that fails removes its record, its brief and its tab, so the parent hears nothing about a child that never ran.
- **The daemon keeps the state, and every adapter is a client of it.** The daemon keeps the registry, the outbox and the herdr subscriptions for every session on the machine. An adapter, the Pi extension or a Claude Code MCP server, holds none of them. It sends its identity with every call, as its herdr pane and its child id, and the daemon resolves that against the child records it holds. Never read a parent or a child id from the daemon's own environment, which belongs to whichever session started it.
- **Give each Claude Code child its own MCP server.** The spawn writes `~/.bellwether/mcp/<child id>.json` with mode 0600 and passes it as `--mcp-config=<file>`. The file lists one server, which runs the packaged channel entry with `--child <child id>`. A resume writes it again for the same child id. A child that exits, or whose spawn fails, takes the file with it, as it takes its brief. A child on another machine doesn't get one, because that machine's daemon doesn't store a record of it.
- **Answer Claude Code's startup dialogs for the person.** Each Claude Code child opens on the development-channel confirmation, because Claude Code loads a `server:` channel only under `--dangerously-load-development-channels`, and that flag always asks. A folder Claude Code has not seen also asks the folder-trust question. The spawn answers both, saying yes to the trust question for any folder, because the operator approves every spawn by default. It moves the selection toward the accepting option and sends Enter only once the screen shows that option selected. A dialog still on screen after 30 s fails the spawn, with an error that specifies the dialog. While the spawn answers, `startingUntil` on the child record stops the watcher from reporting the child. When a resumed session shows a startup dialog later, the watcher answers it and does not publish a `blocked` event.
- **Send input only to panes this parent started.** A parent must never type into a pane it does not own.
- **Wake the parent through its harness.** `pi.sendMessage(..., {triggerTurn: true, deliverAs: 'followUp'})` for Pi, `notifications/claude/channel` for Claude Code. Never type into the parent's own pane.
- **A receipt marks an event read.** Sending a notification does not prove a turn started.
- **Tests run Bellwether on a socket and home of their own.** Every test script loads `test/fixtures/isolation.ts` with `--import`. It sets `BELLWETHER_HOME` and `BELLWETHER_DAEMON_SOCKET` under a temporary root, and throws when a test connects to or listens on anything under the live `~/.bellwether`. `test/unit/isolation.test.ts` fails when a script drops the preload. A test that touches the live daemon or the real registry is a defect.
- **Install the tool a check needs.** Vale, `gh`, `jq` and the rest are part of the work, not an excuse to skip it. Take the version that the dotfiles pin with `mise`, which is how this machine gets Vale 3.20.0, and on a machine without mise install that same release by hand. When an install cannot happen, name what blocked it in the pull request and leave the check failing. A missing binary never counts as a pass.

## Test tiers

`npm test` runs all three tiers. Each has its own npm script, and the briefs behind them sit in `docs/test-briefs/`.

1. **Unit.** `test/unit/daemon-protocol.test.ts` covers the daemon wire format. `test/unit/classifier.test.ts` drives the settle times with a hand-picked clock. `test/unit/outbox.test.ts` covers merging and receipts against a scratch home. `test/unit/registry.test.ts` covers persistence. Each case takes its clock and its directory as an argument.
2. **Fake socket.** `test/fixtures/fake-herdr.ts` is a Unix socket server that speaks the newline-delimited protocol, and `test/fixtures/herdr-methods.ts` refuses an unknown method or a missing field. `test/integration/daemon.test.ts` covers one service per parent, event fan-out, replay after a reconnect, bye, drain and the idle exit. `test/integration/watcher.test.ts` covers the text a parent receives for a child event. `test/integration/startup-dialogs.test.ts` plays Claude Code's two startup dialogs in a scripted pane, and shows the spawn answering them with nothing published, a dialog that never goes away failing the spawn by name, and a stale `blocked` entry dropped at delivery. `test/integration/fake-socket.test.ts` covers the subscribe acknowledgement, an event buffered ahead of it, `events_lost`, a dropped connection and the request round trip. A client starts its daemon detached, so a case that starts one stops it with `test/fixtures/daemons.ts`, and the last case in `test/integration/claude-channel.test.ts` fails when a daemon is still running after its test.
3. **Lab.** `test/lab/herdr-lab.ts` starts a real herdr server in its own config root and session, with a guard that refuses the live socket. `test/lab/scripted-models.ts` serves an OpenAI-compatible endpoint for Pi and an Anthropic Messages endpoint for Claude, including a stall reply that produces the stuck event. `npm run test:lab` runs it, and the files skip themselves when `herdr` is absent, so CI remains green.
4. **Live smoke.** The same lab with real models at the cheapest tier, run by hand before a release.

Scripted replies for each parent and child pair come next. The fixtures exist, and the work left is the orchestration that starts Pi and Claude in a lab pane.

The lab removes `HERDR_ENV`, `HERDR_PANE_ID` and `HERDR_SOCKET_PATH` from the child environment, because inherited values point at the live server. It refuses to start when the resolved socket is `~/.config/herdr/herdr.sock`. The lab root is under `/tmp`, because macOS caps a Unix socket path at 104 bytes and a root under the default temp directory exceeds that cap.
