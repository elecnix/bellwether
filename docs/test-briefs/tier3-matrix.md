# Brief: the tier 3 pair matrix

`docs/test-briefs/tier3.md` describes the whole lab. Two of its fixtures now exist and are merged:

- `test/lab/herdr-lab.ts`, a real isolated herdr server with a guard that refuses the live socket.
- `test/lab/scripted-models.ts`, an OpenAI-compatible endpoint for Pi and an Anthropic Messages endpoint for Claude, with a stall reply.

What is missing is the orchestration: starting a real Pi and a real Claude inside a lab pane, pointing each at a scripted endpoint, and driving the five child events across the four parent and child pairs.

Read `test/lab/herdr-lab.ts`, `test/lab/scripted-models.ts`, `src/core/spawn.ts` and the design document before you start.

## Deliverables

- `test/lab/harness-run.ts`: start a harness in a lab pane.
  - Create the tab and pane through the Bellwether client, with `tabCreate`.
  - Pi: type `pi` into that pane's shell with `PI_CODING_AGENT_DIR` pointing at a lab directory whose model config names the scripted endpoint's URL as the provider base. Pi must run in its TUI, because herdr's Pi state reporting skips a non-TUI session.
  - Claude: type `claude` with `CLAUDE_CONFIG_DIR` in the lab and `ANTHROPIC_BASE_URL` pointing at the scripted endpoint.
  - Wait until herdr reports the agent in the pane before you assert anything.
- `test/lab/matrix.test.ts`: the four pairs and the five events.

## The four pairs

Pi parent with Pi child. Pi parent with Claude child. Claude parent with Claude child. Claude parent with Pi child.

## The five events

| Event | Pi child | Claude child |
| --- | --- | --- |
| report | the scripted reply calls `parent_report` | the same |
| idle | the scripted reply ends the turn with text only | the same |
| blocked | a test extension opens `ctx.ui.confirm` | the scripted reply contains a Bash tool call, and the default permission mode stops it at a dialog |
| stuck | the endpoint writes the headers and then stalls past the test threshold | the same, on the Messages endpoint |
| exited | the test closes the pane | the same |

Lower the idle settle and the stuck threshold through the spawn options. Do not edit `src/core/classifier.ts`.

## The rule that decides a pass

A test passes only when the parent's transcript contains the receipt followed by a new assistant message, and the outbox marks the entry read. A sent notification proves nothing on its own.

## Rules

- Skip the file, with a clear reason, when `herdr` is not on `PATH`, so CI stays green on a runner without it.
- The lab must never bind `~/.config/herdr/herdr.sock`. `startLab()` asserts that; keep the assertion.
- One server per file where you can, and a timeout on every test well under the job's.
- `npm run typecheck` and `npm test` must pass before you push. Run `npm run test:lab` after each change to it.
- Node's built-in `node:test` and `node:assert`. Add no dependencies.
- If a pair cannot be driven, skip that case with the reason in the test name or a comment, and say so in your report. A skipped cell with a reason is worth more than a false pass.
