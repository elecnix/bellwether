# Model of the daemon's state and mutations

A TLA+ model of what the daemon holds and what the acts do to it: machines, sessions, panes, workspaces, children, claims, relay links, briefs, messages, reports, restarts, resumes, moves and retirements.

It exists to answer one kind of question before code is written: **which sequences of steps can leave a child watched by two parents, a session with no pane and no trace, a brief recorded as taken but never read, or a release shipping a change no note mentions.** Each of those happened once, on a real fleet, before the model existed.

`everystate` checks it. It is a TLA+ model checker in Rust, so no Java is needed:

```sh
npm install -g everystate     # or: brew install mattzcarey/tap/everystate
./run-all.sh
```

`run-all.sh` runs one configuration per invariant and prints one line each: the exit code, then the invariant's name, the number of distinct states and the action names of the shortest trace. Exit `0` means the invariant holds at that bound, exit `12` means a reachable state breaks it. Set `EVERYSTATE` if the binary is somewhere else.

`run-all.sh` runs each configuration through `check.sh`, which stops the checker once it passes a memory ceiling: 4G by default, or the size in `EVERYSTATE_MEMORY`. `everystate` keeps every state it has seen in memory, so a configuration with no bound on its states grows until the machine swaps. Run one configuration through `./check.sh` too, with the arguments `everystate` takes.

## What each file is

| File | What it models |
| --- | --- |
| `Claims.tla` | Who watches which pane: local and far adoption, a session changing under a pane, resume checks, and the relay's claims |
| `Lifecycle.tla` | Panes, workspaces and worktrees: restarts, crashes during a restart, reaping, resumes, and herdr removing an empty workspace |
| `Delivery.tla` | A brief and a message: the push, the adapter's receipt, a stray status, a turn, a read, an ack timeout and a resend |
| `Release.tla` | A release: opening the window, merging pull requests during it, finishing it, and the note each merged change needs |
| `<Spec>.cfg` | The full configuration for one spec, used while writing it |
| `<Spec>-<Invariant>.cfg` | One invariant and nothing else, so a run reports that invariant's verdict instead of stopping at the first breach |
| `<Spec><Assumption>-<Invariant>.cfg` | The same invariant with some of the spec's conditions turned off, such as `ClaimsSettled`, to show which conditions a breach depends on |
| `run-all.sh` | Runs every one-invariant configuration |

## The invariants

| Invariant | What it says | Verdict |
| --- | --- | --- |
| `RouteToWatcher` | A pane's reports reach the parent whose record names it | Breaks: `FarAdopt`, `SessionChange`, `WatcherExit`, `SessionChange`; **holds** in `ClaimsSettled` |
| `NoPaneTwoParents` | No pane is watched by two parents | Breaks: `FarAdopt`, `SessionChange`, `LocalAdopt`, in both configurations |
| `PaneOneLiveChild` | A pane holds at most one live child | Breaks, same trace |
| `IdStableBySession` | A child's id does not change while its session is the same | Breaks in both configurations |
| `IdStableInPane` | A child's id does not change while its pane is the same | Breaks in both configurations |
| `OneSessionPerId` | One child id names one session | Breaks in both configurations |
| `SessionOnePane` | A session runs in at most one pane | Breaks: `LocalAdopt`, `SessionChange`, `ResumeCheck`, `SessionChange`, `ResumeStart`; **holds** in `ClaimsSettled` |
| `FarClaimCurrent` | A far claim names the pane that holds the session | Breaks: `FarAdopt`, `SessionChange`, in both configurations |
| `RouteUnambiguous` | One pane's reports go to one parent | Breaks: `FarAdopt`, `SessionChange`, `WatcherExit`, `ResumeCheck`, `ResumeStart`; **holds** in `ClaimsSettled` |
| `NoPaneTwoParentsCurrent` | No pane is watched by two parents whose records match its session and aren't in doubt | Breaks in both configurations |
| `PaneOneLiveChildCurrent` | The same, for live children | Breaks in both configurations |
| `RestartLeavesTrace` | A restart that closes a pane and fails leaves a record | Breaks: `OpenNew`, `LetGo`, `CloseErr` |
| `RecordNamesPane` | A record names a pane that exists | Breaks: `OpenNew`, `LetGo`, `Crash` |
| `LiveWorktreeKept` | A worktree a live child works in is never removed | Breaks: `ReapCheck`, `ReapBusy`, `ResumeClear`, `ReapRemove` |
| `LiveWorkspaceKept` | A workspace holding a live session is never removed | Breaks: `OwnerCloses`, `RelList`, `SpawnInto`, `RelClose`; **holds** when herdr removes an empty workspace |
| `TakenMeansTurn` | A brief is taken only if the model began a turn on it | Breaks: `Push`, `AdapterQueue`, `Stray`, `Record`; **holds** with no stray status, with or without a resend |
| `EntersOnce` | A message enters a session exactly once | Breaks: `Push`, `AckTimeout`, `AdapterQueue` |
| `ShippedHasNote` | A merged pull request has a note in the release that ships it | Breaks: `Open`, `StartRelease`, `Merge`, `FinishRelease` |
| `NoNoteUnderPublished` | No note is filed under an already published version | Breaks: `Open`, `StartRelease`, `FinishRelease`, `Merge` |

Five configurations hold, and they earn their place: `LifecycleHerdrRemovesEmpty-LiveWorkspaceKept.cfg`, `DeliveryNoStrayNoResend-TakenMeansTurn.cfg`, and `ClaimsSettled-RouteToWatcher.cfg`, `ClaimsSettled-RouteUnambiguous.cfg` and `ClaimsSettled-SessionOnePane.cfg`. Each shows what a breach depends on. The first needs herdr to keep an empty workspace; the second needs a `working` status that the brief did not cause, which `Stray` stands for.

With `StrayWorking = FALSE` and `MaxPushes = 2`, the checker doesn't find a breach, so a resend on its own leaves `TakenMeansTurn` intact. A fix that removes one assumption turns a breach into a hold, and the config file is where that is written down.

## Verdicts from the model

`Claims.tla` declares three conditions as constants. When one evaluates to `TRUE`, something goes wrong that the code can't prevent alone:

- `HandResumes`: a person starts a session by hand while a resume of it is waiting.
- `CleanupFails`: `relay-cleanup` fails when a far child exits, as when the relay is down. The adopted claim then stays after its child.
- `AnswersLost`: a `relay-adopt` answer times out after the far daemon saved the claim.

`Claims-<Invariant>.cfg` turns all three on, at three child ids. `ClaimsSettled-<Invariant>.cfg` turns all three off, at two child ids, so a configuration that holds finishes in seconds. At three ids, a settled configuration that holds never finished within 9G. A hold in `ClaimsSettled` means no breach at two ids. Each breach below also occurs at three.

Issue #244 fixed three defects in the code, and the model reflects each fix:

- `decideClaim` answered `held` from a parent's own claim on a session that had left the pane. That parent then gave the old child id to the new session. `Decide` now checks for a stale claim first. The replay is `test/integration/claims.test.ts`.
- The daemon on the pane's machine didn't count a child that a far parent had started, so a parent there could adopt it too. The daemon there now counts that child for as long as its adapter stays connected from the pane. In the model, a started child's adapter connection appears in `relay` with `adopted = FALSE`, and it ends when its pane's session ends. The replay is `test/integration/remote-adopt.test.ts`.
- `comeBack` brought back a local adopted child whose session returned to its pane, even after a far parent had adopted that pane. `ComeBack` now asks `Decide` for a local child too. The replay is `test/integration/claims.test.ts`.

| Invariant | All three on | All three off | One condition alone | Verdict |
| --- | --- | --- | --- | --- |
| `FarClaimCurrent` | Breaks | Breaks | Needs none | **Model stricter than the code can keep.** herdr changes a pane's session in one step, and the far parent's watcher responds on its next step. Since #222, that step ends the child and runs `relay-cleanup`, so the lag lasts one step. At 0.1.9, `EMPIRICAL.md` saw a stale claim until the pane closed, because no step ended it then. |
| `NoPaneTwoParents` | Breaks | Breaks | Needs none | **Model stricter**, with the same one-step lag: the far record shows a session the pane no longer runs. `NoPaneTwoParentsCurrent` states what the code can keep. `EMPIRICAL.md` saw this live at 0.1.9, before #222, when the far child never left. |
| `PaneOneLiveChild` | Breaks | Breaks | Needs none | **Model stricter**, as `NoPaneTwoParents`. |
| `NoPaneTwoParentsCurrent` | Breaks | Breaks | Needs none | **Code wrong, during an outage.** A far parent's watcher that misses its session leaving the pane and returning keeps a record that matches the pane again, though another adoption removed its claim. The code never makes a far parent confirm its claims once its relay reconnects, which #257 tracks. |
| `PaneOneLiveChildCurrent` | Breaks | Breaks | Needs none | **Code wrong**, with the same cause as `NoPaneTwoParentsCurrent`. |
| `IdStableBySession` | Breaks | Breaks | Needs none | **Code wrong.** A resume of an adopted child keeps `origin: 'adopt'`, although the resumed process gives its adapter the child id. A `/clear` ends the child as adopted while that adapter stays connected from the pane, so adopting the pane again answers `held` with the old id for the new session. The fix changes which children retirement touches, which #256 tracks. |
| `IdStableInPane` | Breaks | Breaks | Needs none | **Code wrong**, with the same cause as `IdStableBySession`. |
| `OneSessionPerId` | Breaks | Breaks | Needs none | **Code wrong**, as `IdStableBySession`. The hand-off issue described one trace: two `FarAdopt` steps over a parent's own stale claim. That trace no longer occurs. |
| `RouteToWatcher` | Breaks | **Holds**, 665,039 states | `CleanupFails` breaks it. No breach in 200 s with `HandResumes` or `AnswersLost` alone | **Code wrong, after a failed cleanup.** An adopted claim stays after a `relay-cleanup` that failed, and the far daemon has no retry or expiry for it, which #258 tracks. A started child no longer leaves this residue, because its hold ends with its connection. |
| `RouteUnambiguous` | Breaks | **Holds**, 665,039 states | `CleanupFails` breaks it, through the same residue. `HandResumes` breaks it after the session runs in two panes | **Code wrong after a failed cleanup**, with the same cause as `RouteToWatcher`. Before issue #244, the settled configuration also broke through `ComeBack`. |
| `SessionOnePane` | Breaks | **Holds**, 665,039 states | `HandResumes` breaks it. No breach in 200 s with `CleanupFails` alone | **Not a code defect.** A person resumes the session by hand between the resume's check and its start. The code takes the session's lock, which a person's shell doesn't take. |

`ClaimsNoHandResume-SessionOnePane.cfg` turned off `HandResumes` alone, at three ids. On 2026-11-27 it filled a 32 GB machine. `ClaimsSettled-SessionOnePane.cfg` replaces it.

### Invariants whose wording changed

These invariants now count only adopted claims, since `relay` also records the started children's connections. A connection has no session, and `adoptedParentOf` routes only through adopted claims. A reviewer of the model should read these first, because the change narrows what they say:

- `FarClaimCurrent`: `r.adopted => paneSession[r.pane] = r.session`.
- `RouteUnambiguous`: the candidates from `relay` include only adopted claims.
- `RouteToWatcher`: it applies to an adopted claim only.

Before issue #244, every record in `relay` was an adopted claim. For every state reachable in the earlier model, each invariant says what it said before.

## What the model is not

The spec was written from the code by hand, at `origin/main` 2645cf4, and the checker has not seen a recorded run. `everystate conform -trace FILE.jsonl SPEC.tla` checks a log of the real system against the spec, which answers a different question: not whether a bad state is reachable, but whether what happened was legal. The logs the daemon writes today record outcomes, not steps, so a useful conformance run would need a trace of steps first.

Every invariant that breaks here is a statement about the model. To turn one into a statement about the code, write the test that replays its trace and watch it fail. That failure is the proof, and the model is where it starts.
