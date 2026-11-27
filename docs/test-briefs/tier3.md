# Bellwether test brief: tier 3, the lab

Tier 1 lives in `test/unit/`, and tier 2 lives in `test/integration/fake-socket.test.ts`. This brief covers tier 3, so read `bellwether-design.html`, especially "Lab isolation" and "Producing each event in the lab".

## What tier 3 covers

A real, isolated herdr server with real Pi and Claude processes and scripted model replies. It exercises the four parent and child pairs and each of the five child events.

## Deliverables

- `test/lab/herdr-lab.ts`: starts and stops one isolated herdr server per test.
- `test/lab/fake-provider.ts`: a scripted HTTP provider for Pi.
- `test/lab/fake-anthropic.ts`: a scripted Anthropic Messages server for Claude.
- `test/lab/*.test.ts`: the four pairs and the five events.

## Isolation, exactly as the design words it

- Build the environment from scratch. `HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME` and `XDG_RUNTIME_DIR` point under a temp root, with `HERDR_CONFIG_PATH` and `SHELL=/bin/sh`.
- Remove `HERDR_ENV`, `HERDR_PANE_ID` and `HERDR_SOCKET_PATH`, because values inherited from a pane point at the live server.
- Run `herdr --session bw-<random> server`, so the socket is `<XDG_CONFIG_HOME>/herdr/sessions/bw-<random>/herdr.sock`.
- Refuse to start when the resolved socket is `~/.config/herdr/herdr.sock`. Assert it before binding.
- Shutdown calls `server.stop`, then checks with `ps -p <pid> -o lstart=,command=` that no process with that start time remains. Delete the temp root only after that check passes.
- Remove every provider key, token and cloud credential before a case runs, and print one line naming them. A person keeps one by naming it in `BELLWETHER_LAB_KEYS`, and a lab pane receives it only when the case passes the name to `startLab({ keys })`.
- `BW_LAB_KEEP=1` leaves the temp root and prints the attach command.

## The models

- Pi runs with a scripted HTTP provider, and the lab installs herdr's Pi integration under its own `PI_CODING_AGENT_DIR`. Pi must run in its TUI, because herdr's Pi state reporting skips non-TUI sessions.
- Claude runs with `CLAUDE_CONFIG_DIR` in the lab and herdr's Claude hook installed there. Its model calls go to a scripted Anthropic Messages server through `ANTHROPIC_BASE_URL`.

The probe branch already wrote a scripted Anthropic server and a channel stub under `scripts/`. Reuse that code rather than writing a second one.

## Producing each event

| Event | Pi child | Claude child |
| --- | --- | --- |
| report | the scripted reply calls `parent_report` | the same |
| idle | the scripted reply ends the turn with text only | the same |
| blocked | a test extension opens `ctx.ui.confirm` | the scripted reply contains a Bash tool call, and the default permission mode stops it at a dialog |
| stuck | the provider sends the response headers and then waits past the test threshold | the same, on the Messages server |
| exited | the test calls `pane.close` | the same |

Lower the idle settle and the stuck threshold through the spawn options for the lab. Do not edit the defaults in `src/core/classifier.ts`.

## Pass criteria

A test passes only when the parent's transcript contains the receipt followed by a new assistant message, and the outbox marks the entry read. Delivery alone does not prove that a turn started.

## Rules

- Skip the whole file, with a clear reason, when `herdr` is not on `PATH`, so CI still passes on a runner without it.
- One server per file where you can. Give every test a timeout well under the job's.
- `npm run typecheck` and `npm test` must pass before you push.
- Node's built-in `node:test` and `node:assert`. No new dependencies.
