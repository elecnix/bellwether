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
- **Send input only to panes this parent started.** A parent must never type into a pane it does not own.
- **Wake the parent through its harness.** `pi.sendMessage(..., {triggerTurn: true, deliverAs: 'followUp'})` for Pi, `notifications/claude/channel` for Claude Code. Never type into the parent's own pane.
- **A receipt marks an event read.** Sending a notification does not prove a turn started.

## Test tiers

`npm test` runs all three tiers. Each has its own npm script, and the briefs behind them sit in `docs/test-briefs/`.

1. **Unit.** `test/unit/daemon-protocol.test.ts` covers the daemon wire format. `test/unit/classifier.test.ts` drives the settle times with a hand-picked clock. `test/unit/outbox.test.ts` covers merging and receipts against a scratch home. `test/unit/registry.test.ts` covers persistence. Each case takes its clock and its directory as an argument.
2. **Fake socket.** `test/fixtures/fake-herdr.ts` is a Unix socket server that speaks the newline-delimited protocol, and `test/fixtures/herdr-methods.ts` refuses an unknown method or a missing field. `test/integration/daemon.test.ts` covers one service per parent, event fan-out, replay after a reconnect, bye, drain and the idle exit. `test/integration/fake-socket.test.ts` covers the subscribe acknowledgement, an event buffered ahead of it, `events_lost`, a dropped connection and the request round trip.
3. **Lab.** `test/lab/herdr-lab.ts` starts a real herdr server in its own config root and session, with a guard that refuses the live socket. `test/lab/scripted-models.ts` serves an OpenAI-compatible endpoint for Pi and an Anthropic Messages endpoint for Claude, including a stall reply that produces the stuck event. `npm run test:lab` runs it, and the files skip themselves when `herdr` is absent, so CI remains green.
4. **Live smoke.** The same lab with real models at the cheapest tier, run by hand before a release.

Scripted replies for each parent and child pair come next. The fixtures exist, and the work left is the orchestration that starts Pi and Claude in a lab pane.

The lab removes `HERDR_ENV`, `HERDR_PANE_ID` and `HERDR_SOCKET_PATH` from the child environment, because inherited values point at the live server. It refuses to start when the resolved socket is `~/.config/herdr/herdr.sock`. The lab root is under `/tmp`, because macOS caps a Unix socket path at 104 bytes and a root under the default temp directory exceeds that cap.
