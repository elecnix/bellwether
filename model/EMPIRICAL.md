# Which model breaches happen on a real fleet

A model of Bellwether's daemon finds seventeen invariants. A reachable state breaks each one.

Replay tests run the real daemon code, but each one substitutes a fake for herdr, git, a harness, a relay answer or a clock. So a failing replay proves one thing. The code allows the breach *if the fake behaves like the real component*.

The runs below test that condition, invariant by invariant. Real herdr, real Claude Code and pi sessions, and two machines that each run a Bellwether daemon supply the components.

Between 03:19 and 03:38 UTC on 2026-11-28, the runs took place. Both machines ran herdr 0.9.5 and Bellwether 0.1.9 (build `150094f`), Claude Code 2.1.332 and pi. On the parent's machine ran the live daemon that the fleet uses.

Each artifact below sits under `~/.local/share/bellwether-empirical/` on the parent's machine, with probe scripts in `probes/` and outputs in `artifacts/`. Probes speak herdr's socket protocol directly, one request per connection as `src/core/herdr-client.ts` does, and none of them loads Bellwether code. Afterwards, the runs closed every session, child, tab and workspace they opened. The scratch folder on the second machine no longer exists.

## Which code the runs saw

The runs used 0.1.9. The fixes that changed a model verdict on 2026-11-28 all came later: #213, #216, #217, #221, #223, #225 and #248. A row below describes 0.1.9. `README.md` gives each invariant's verdict at f3fe3a7, and none of those verdicts contradicts a row here.

## Levels

| Level | Meaning |
| --- | --- |
| **live** | reproduced against real herdr, real harnesses and a real daemon, with a command and an artifact |
| **half** | one real component and one fake. The row says which is which and why the real one was unavailable |
| **model only** | needs a machine, a version or a timing that nobody has here. The row says what it would take |

## The table

| Invariant | Level | What happened |
| --- | --- | --- |
| `LiveWorkspaceKept` | **live: the fake is wrong, and the code is fine on herdr 0.9.5** | Real herdr removes a workspace when its last tab closes. `tab.list` on it then answers `workspace_not_found`, never `[]`, so `releaseWorkspace` returns `gone` and never sends `workspace.close`. A `tab.create` into that id also fails with `workspace_not_found`, so the `SpawnInto` step cannot create a tab there. The fake in `live-workspace-kept.test.ts` keeps an empty workspace and accepts a tab into it, which herdr 0.9.5 never does. |
| `NoPaneTwoParents` | **live** | A parent on the first machine adopted a Claude Code pane on the second machine (`FarAdopt`). `/clear` in that pane changed its session (`SessionChange`). A pi parent started by hand on the second machine then adopted the same pane (`LocalAdopt`), and the adoption succeeded. Both registries then listed a live child on that pane. |
| `PaneOneLiveChild` | **live** | Same run: two live child records, `04bb4a5cb11b3a3e` on the first machine and `336bd3e56e6c150e` on the second, both on pane `wA:p1` and both recording the new session. |
| `FarClaimCurrent` | **live** | After the `/clear`, herdr reported session `3d2c9e9c…` in the pane. The far claim still read `432c2cb0…` 30 s later and until the pane closed. |
| `OneSessionPerId` | **live** | The same far child, adopted on `432c2cb0…`, later carried `3d2c9e9c…` under the same id. The watcher wrote the new session onto the old id. For `/clear` this may be the intended behavior. For herdr reusing a pane it is not. The code treats the two cases alike. |
| `IdStableBySession` | **live** | Claude Code session `066f7a8f…` ran in pane x, and adopting it gave child id `aeb3d87a73e53224`. `/exit` in x, then `claude --resume 066f7a8f…` by hand in pane y, then an adoption of y gave a second id, `ef0123d40355ed12`. Both records were live, because the watcher never marked x exited in the minutes that followed. |
| `RecordNamesPane` | **live for the window; half for the crash** | During a real `agent_restart` of a pi child, a 5 ms poll of the registry file saw `paneId: ""` with no `tabId` for about 190 ms, between the old pane and the new one. A daemon that stops inside that window would leave the record that way, which is the model's `Crash` step. I did not stop the machine's shared daemon mid-restart, because every other session on the machine depends on it. |
| `RouteToWatcher` | **half for its own trace; the property also fails live by another path** | Real: herdr, Claude Code, both daemons and the SSH relay. Fake: the lost relay answer. Losing that answer needs the far daemon frozen for longer than the 15 s relay timeout after it saves the claim. The far daemon serves other sessions, so the permission policy refused the freeze, and no environment variable sets `readTimeoutMs`. The property failed live all the same. After the `NoPaneTwoParents` run, the pane's session no longer had `parent_report` at all (`route-probe-screen.txt`). Both parents' records list the pane, and its reports go to neither. Before the second adoption, a report from the cleared session arrived at the first parent under the old id (`FAR-PROBE-4471`). |
| `EntersOnce` | **half** | Real: the daemon, herdr and a pi child whose adapter took longer than the 5 s acknowledgement bound. Fake: the stall itself. `SIGSTOP` on the child is the only stall available without root, and the pane's shell reclaims the terminal from a stopped job. herdr then refuses `agent.prompt` with `is no longer the pane foreground process`, so the message entered the session once, after `SIGCONT` and `fg`. A stall that leaves the process in the foreground, such as a ptrace stop or a frozen cgroup, needs root (`kernel.yama.ptrace_scope = 1`, a root-owned session scope). In the registry, every typed message went to a session that had no connection. A 5 s timeout typed none. |
| `TakenMeansTurn` | **half** | Real: herdr and the harnesses. Fake: the stray `working`. Unprompted starts of Claude Code and pi, 40 s each, went from `unknown` to `idle` with no `working`. In the 11 Claude Code spawns the fleet ran that night, the `working` that counted as the take came 47 to 320 ms *after* the adapter's receipt each time, never before it. The breach needs a `working` that the brief did not cause, and I saw none. Main fixed the rule in #216, which needs a read receipt and a turn together. |
| `SessionOnePane` | **half** | Real herdr and Claude Code could do it. The trace needs two parent sessions on one machine to call `agent_spawn` with `resume` on one session at the same moment, one by child name and one by session id, so they take different locks. I cannot time two agents' tool calls to the same moment from here. The replay issues both calls from one process against a fake herdr. |
| `RouteUnambiguous` | **half** | Its trace continues the `NoPaneTwoParents` run: the first session comes back to pane x and the local parent's watcher learns it. The run stopped before that step to clean up. The replay simulates the watcher step with `updateChild`. |
| `IdStableInPane` | **half** | The trace needs the watcher to miss a session that comes back to the same pane. A live watcher sees that return and brings the record back with `backInPane`, so missing it needs the daemon down at that moment. The machine's daemon serves other sessions, so I did not stop it. |
| `RestartLeavesTrace` | **half** | The trace needs `tab.close` to close the tab and answer an error. Every `tab.close` sent to herdr 0.9.5 here answered `ok`. An error after the close needs herdr to stall past the 5 s request timeout. The replay forces that answer from a fake. Main fixed the restart in #213. |
| `LiveWorktreeKept` | **half** | Real git works the same as the fake here. The trace needs a resume to clear the record while `reapChild` waits in its process check. The replay keeps that check waiting behind a gate. No real component offers such a gate, and a real run would remove a real worktree. |
| `ShippedHasNote` | **half** | In the history, each of the 16 pull requests released in 0.1.8 and 0.1.9 has a `prs` line in `features.ts` or the `release-note: none` label, so none breaches. The breach needs a merge between the version check and the release commit, which takes a real release run with a merge timed into it. The replay scripts git and gh. Main changed the check in #223. |
| `NoNoteUnderPublished` | **model only** | The replay passed at `ba7101c`: the check refuses the modelled step. A breach needs a note filed under a version already published, then a release, which nobody runs as an experiment. Main refuses such notes since #223. |

That makes seven invariants whose breach state appeared on real components: `LiveWorkspaceKept` with its premise disproved, plus `NoPaneTwoParents`, `PaneOneLiveChild`, `FarClaimCurrent`, `OneSessionPerId`, `IdStableBySession` and the window of `RecordNamesPane`. `RouteToWatcher` failed live by a path other than its trace.

## The commands and artifacts

The commands below ran on the parent's machine unless noted. Artifact and probe paths are relative to `~/.local/share/bellwether-empirical/`.

### `LiveWorkspaceKept`

```sh
node probes/workspace.mjs > artifacts/workspace-probe.json
```

In the first part, the probe creates a workspace with a second tab and closes both tabs one at a time. After each close, it requests the tab list and the workspace. A second workspace runs `sleep 4242`, and the probe closes it with the process alive.

Output from the probe shows `tab.list` answering `workspace_not_found` once the last tab closed, and `tab.create` into the old id answering the same. `workspace.close` on the second workspace answered `ok` and killed the process. So real herdr does close a workspace that contains a live tab, but `releaseWorkspace` never calls it with a tab inside, because an empty workspace never exists. Its herdr schema is `herdr-0.9.5-schema.json`.

### `NoPaneTwoParents`, `PaneOneLiveChild`, `FarClaimCurrent`, `OneSessionPerId`, `RouteToWatcher`

1. On the second machine, `probes/herdr.mjs` created workspace `wA` and started `claude` in pane `wA:p1`, on session `432c2cb0…`.

2. On the first machine, `agent_adopt` with target `hawthorne:wA:p1` gave child `04bb4a5cb11b3a3e`. The claim is in `artifacts/far-claim-before-clear.json`.

3. `/clear` typed into `wA:p1`. herdr then reported `3d2c9e9c…` (`artifacts/far-pane-after-clear.json`), while the claim kept `432c2cb0…` (`artifacts/far-claim-after-clear.json`, and 30 s later `artifacts/far-record-after-clear-30s.json`).

4. A prompt typed into the cleared session asked it to call `parent_report`. The first parent received the report as `FAR-PROBE-4471` (`artifacts/far-report-after-clear-screen.txt`). Claude Code's own session file gave the new session (`artifacts/far-server-identity.txt`).

5. A pi child of the first parent, on the same machine, tried the same far adoption, and the local registry already listed the pane, so the adoption failed. That is the same-machine variant of the trace, and it holds.

6. On the second machine, I told a pi session started by hand in pane `wA:p2` to adopt the pane by its herdr name. The adoption succeeded as `336bd3e56e6c150e` (`artifacts/local-adopt-l1-screen-3.txt`).

7. Both records and the claim are in `artifacts/two-parents-f1-record.json` and `artifacts/two-parents-hawthorne-side.jsonl`.

8. A second prompt asked the session to report again. It no longer had `parent_report` (`artifacts/route-probe-screen.txt`).

### `IdStableBySession`

1. `claude` in pane x (`w7R:p1`), given one prompt so that Claude Code stores the session (`artifacts/idstable-x2.json`). `claude --resume` cannot resume a session that never received a prompt: it answers `No conversation found`.

2. `agent_adopt` on x gave `aeb3d87a73e53224`.

3. `/exit` in x, then `claude --resume 066f7a8f…` in pane y (`artifacts/idstable-y2.json`).

4. `agent_adopt` on y gave `ef0123d40355ed12`. Both records are in `artifacts/idstable-by-session-records.jsonl`, both live.

### `RecordNamesPane`

```sh
node probes/watch-record.mjs ~/.bellwether/parents/<parent>.json <child id> 60 \
  > artifacts/record-names-pane-restart.json
```

The command ran while `agent_restart` restarted a pi child. It saw pane `w7S:p1`, then `paneId: ""` at 03:37:03.212, then pane `w7S:p2` at 03:37:03.399. `~/.bellwether/restart.log` records the restart as `restarted`.

### `EntersOnce`

1. `agent_spawn` of a pi child that echoes each message.

2. `kill -STOP -- -<pgid>` on the child's pi process group, then `agent_send` with text `EO-PROBE-7319`.

3. The tool answered `herdr agent w7P:p1 is no longer the pane foreground process`, because the pane's bash had marked the job stopped.

4. `kill -CONT`, then `fg` typed into the pane. The session file (`artifacts/enters-once-sigstop-pi-session.jsonl`) contains one `bellwether-message` for the probe and one reply. In the child's record (`artifacts/enters-once-sigstop-child-record.json`), that message has no entry.

A ptrace stop failed with yama scope 1 (`artifacts/gdb-freeze.log`).

### `TakenMeansTurn`

```sh
PROBE_CWD=<a trusted checkout> node probes/stray.mjs stray-claude 40 command claude > artifacts/stray-claude.json
PROBE_CWD=<a trusted checkout> node probes/stray.mjs stray-pi 40 command pi > artifacts/stray-pi.json
```

Each run shows `pane_agent_detected`, then one `pane.agent_status_changed` to `idle`, then 37 or 38 `idle` reads at one-second steps. The brief records of that night's spawns are in `artifacts/brief-takes-2026-11-28.json`.

### `ShippedHasNote`

`artifacts/release-notes-audit.txt` lists each pull request between the 0.1.7 and 0.1.8 release commits and between the 0.1.8 and 0.1.9 release commits, with its `prs` line in `features.ts` at the release commit and its labels.

## Findings outside the model

These came up during the runs. None is an invariant the model states, and each one has an artifact.

- **`agent_adopt` misreads real herdr pane ids.** `src/integrations/tools.ts:370` treats a target's first segment as a workspace only when it matches `/^w\d+$/`. herdr 0.9.5 calls its workspaces `w7R`, `wA` and the like, so `w7R:p1` reads as machine `w7R`, pane `p1`, and fails with `herdr has no saved machine w7R`. It failed that way on both machines. Every fixture uses `w1`, so no test sees it. Adopting by the agent's herdr name works.

- **A message can enter a session after `agent_send` reports a failure.** In the `EntersOnce` run, `agent_send` returned an error and recorded nothing about the message, yet the session took the pushed message once the process ran again. A parent that retries on that error sends a second copy, which is the `EntersOnce` breach by another route.

- **No Claude Code child read the first copy of its brief.** Each of that night's 11 Claude Code spawns records its first brief copy as undelivered, `its model began no turn on it within 20 s`, with no `receivedAt`. The second copy then arrived and the turn began. In the one session checked, the first copy never entered the conversation at all, so the resend did not double it (`artifacts/brief-resend-bw-empirical-record.json`).

- **An adopted Claude Code session that quits can remain live on its record.** After `/exit` in pane x, the record `aeb3d87a73e53224` remained live for minutes, until the pane closed. An earlier adoption in the same pane, whose session had never taken a prompt, went to exited at once, as `never started`.

- **The second parent's adoption reply misreported the session.** It said the session has no Bellwether server connected to the daemon, while that server had just carried a report.

- **A restart reply warned about a session that had not changed.** `agent_restart` said herdr reported another session for the new pane, while herdr and the record showed the same pi session file 8 s later.

## Believed but not shown

- `RouteToWatcher` on its own trace would fail against real components if the far daemon stopped for more than 15 s after saving a claim. The far side saves the claim synchronously before it answers (`src/daemon/server.ts:687-691` at 0.1.9), so nothing in the real code would undo the claim. I skipped this run, for the reason in the table.

- The cleared session's first report arrived at the first parent although the claim still showed the old session. The channel server probably kept the identity it said hello with. I did not read the daemon log that would show it.

- `RecordNamesPane` with a crash inside the 190 ms window would leave `paneId: ""` until something rewrites the record. That run did not happen.

- A ptrace or cgroup stall longer than 5 s, with the process still in the foreground, would make `EntersOnce` fail as the replay does: herdr would type the message, and the adapter would also push it when it wakes. Both stalls need root here, so neither ran.

- The `NoPaneTwoParents` variant with two far parents on two different machines would also succeed, as the replay says. It needs a third machine running a Bellwether parent, so it did not run.
