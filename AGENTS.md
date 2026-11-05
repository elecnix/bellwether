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

- **Never poll herdr for status.** Status arrives on `events.subscribe`. The only timers are the classifier's settle times and the stuck threshold.
- **Subscribe before the snapshot.** herdr does not replay events, so a subscription opened after a snapshot misses whatever happened between the two.
- **Write the registry record before `tab.create`.** A crash mid-spawn must still leave a trace.
- **Send input only to panes this parent started.** A parent must never type into a pane it does not own.
- **Wake the parent through its harness.** `pi.sendMessage(..., {triggerTurn: true, deliverAs: 'followUp'})` for Pi, `notifications/claude/channel` for Claude Code. Never type into the parent's own pane.
- **A receipt marks an event read**, not a delivery. A sent notification does not prove a turn started.

## Test tiers

1. **Unit.** A fake clock and an in-memory registry. Covers the classifier settle times, outbox merging, receipts and dedupe.
2. **Fake socket.** A Unix socket server that validates each request against `herdr api schema --json`. Covers the subscribe acknowledgement, `events_lost`, a disconnect, a pane closed during subscribe, and reconcile.
3. **Lab.** A real, isolated herdr server with real Pi and Claude processes and scripted model replies.
4. **Live smoke.** The same lab with real models at the cheapest tier, run by hand before a release.

The lab removes `HERDR_ENV`, `HERDR_PANE_ID` and `HERDR_SOCKET_PATH` from the child environment, because inherited values point at the live server. It refuses to start when the resolved socket is `~/.config/herdr/herdr.sock`.
