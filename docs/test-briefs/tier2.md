# Bellwether test brief: tier 2, the fake socket

Tier 1 lives in `test/unit/`. This is tier 2. Read `bellwether-design.html` and `src/core/herdr-client.ts` before you start.

## What tier 2 covers

The design says: a Unix socket server that validates requests against `herdr api schema --json`, covering the subscribe acknowledgement, `events_lost`, a disconnect, a pane closed during subscribe, and reconcile.

Build a fake herdr server that speaks the real wire protocol and a test suite that drives the client against it.

## Deliverables

- `test/fixtures/fake-herdr.ts`: a Unix socket server. It accepts newline-delimited JSON, reads `{id, method, params}`, and answers `{id, result}` or `{id, error}`. It records every request it receives so a test can assert on them.
- `test/fixtures/schema.ts`: loads `herdr api schema --json` once and validates each incoming request against it. An unknown method or a missing required field must fail the test loudly, not be ignored.
- `test/integration/fake-socket.test.ts`: the cases below.

## Cases

- **Subscribe acknowledgement.** `events.subscribe` answers `{result: {type: "subscription_started"}}`. The client resolves only after that frame.
- **Event buffered before the ack.** Send an event frame in the same write as the ack. The client must deliver it, not drop it.
- **`events_lost`.** The server sends an error frame. The client must surface it and reconnect rather than sit silent.
- **Disconnect mid-subscription.** Close the socket while a subscription is open. The client must reconnect with backoff.
- **Pane closed during subscribe.** The subscription names a pane, then the server closes that pane and stops answering for it. `reconcile` must still work for the other panes.
- **Reconcile after a gap.** Subscribe, change a status off-socket, then let `reconcile` read a snapshot and pick up the change.

## Rules

- The server must never bind `~/.config/herdr/herdr.sock`. Assert the path in the fixture before binding, and use a temp directory.
- Start the server on an ephemeral socket path under the OS temp directory.
- A test passes only when the client's observable behaviour matches, not when the server merely received a request.
- `npm run test:integration` must stay green. Tier 3 may skip itself when no herdr binary is present; tier 2 must not skip.
- Node's built-in `node:test` and `node:assert`. No new dependencies.
- Leave `src/` alone unless a test exposes a real defect. If it does, fix it and say so in the PR body.
