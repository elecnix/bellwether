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
| `Lifecycle.tla` | Panes, workspaces and worktrees: restarts, crashes during a restart, a far restart that loses its answer, reaping under the child lock, resumes, and the workspace turn |
| `Delivery.tla` | A brief: the push, the adapter's receipt, a stray status, a turn, a read, an ack timeout, a resend, a typed copy and the hello replay |
| `Release.tla` | A release: both checks, merging pull requests between them, staging, the approval, and the note each merged change needs |
| `Crossing.tla` | A move or teleport of a live child to another machine: the copy, the stop, the start at the destination, the rollback, a daemon that stops part way, and the next daemon's recovery |
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
| `RestartLeavesTrace` | A restart that closes a pane and fails leaves a record | Breaks: `OpenNew`, `LetGo`, `CloseOk`, `Crash` |
| `RecordNamesPane` | A record points at a pane that exists | Breaks: `OpenNew`, `LetGo`, `CloseOk`, `RelayLost`; **holds** for a restart on the parent's machine |
| `LiveWorktreeKept` | The daemon never removes a worktree a live child works in | Breaks: `ReapLock`, `ReapBusy`, `ReapRemove`, `ResumeLock`, `ResumeClear`, with or without the lock's age takeover |
| `LiveWorkspaceKept` | The daemon never removes a workspace holding a live session | Breaks: `OwnerCloses`, `RelList`, `SpawnInto`, `RelClose`; **holds** when every opener takes the workspace turn, and when herdr removes an empty workspace |
| `TakenMeansTurn` | A brief counts as taken only if the model began a turn on it | Breaks: `Push`, `AdapterQueue`, `Enter`, `Read`, `Stray`, `Record`; **holds** without a stray status, with or without a resend |
| `EntersOnce` | A brief enters a session once | Breaks: `Push`, `AdapterQueue`, `Replay`, `Enter`, `Enter`; **holds** with one copy and one adapter process |
| `ShippedHasNote` | A merged pull request has a note in the release that includes it | **Holds**, 2,757 states |
| `NoNoteUnderPublished` | A note never goes under an already published version | Breaks: `Open`, `StartRelease`, `MergeRelease`, `Merge`, `Stage`, `Approve` |
| `NoReleaseOverStaleNote` | No published release carries a note under an earlier published version from a later pull request | **Holds**, 2,757 states |
| `SessionOnePlace` | A session runs on one machine at a time, counting a harness herdr has not reported yet | Breaks: a crossing up to `CLaunch`, then `OtherResume`; with no other starter, `Stop`, `Start` and a recovery up to `RLaunch` |
| `RecordNeverStranded` | A record that no act is working on always has a pane, an exit, a mark or `crossingFailed` | Breaks: a crossing up to `CLaunchFail`, then `RB1`, `RB2`, `Stop` |
| `CopyAccounted` | A crossing either keeps each file it writes on the destination or names it in a mark | Breaks: `CStart`, `CImport`, `Stop` |
| `LeftPlaceRecorded` | A finished crossing records the place it left | **Holds**, 239 states |

Thirteen configurations hold. Each one shows what a breach depends on:

- `ClaimsSettled-RouteToWatcher.cfg`, `ClaimsSettled-RouteUnambiguous.cfg` and `ClaimsSettled-SessionOnePane.cfg` need none of the three outside conditions.
- `LifecycleHerdrRemovesEmpty-LiveWorkspaceKept.cfg` needs herdr to remove an empty workspace, and `LifecycleOneDaemon-LiveWorkspaceKept.cfg` needs every tab opener to take the workspace turn.
- `LifecycleLocal-RecordNamesPane.cfg` holds for a restart on the parent's machine.
- `DeliveryNoStrayNoResend-TakenMeansTurn.cfg` and `DeliveryNoStray-TakenMeansTurn.cfg` need a session that never reports a stray `working`, with one copy or two.
- `DeliveryNoResendOneAdapter-EntersOnce.cfg` needs one copy and one adapter process.
- `Release-ShippedHasNote.cfg`, `Release-NoReleaseOverStaleNote.cfg` and `Crossing-LeftPlaceRecorded.cfg` hold on the spec as written.

Two of them calibrate the model. `LifecycleHerdrRemovesEmpty-LiveWorkspaceKept` and `DeliveryNoStrayNoResend-TakenMeansTurn` held at 2645cf4, and they still hold. A calibration configuration that starts to break means the model drifted, not the code.

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

Issue #256 changed how a parent keeps a resumed adopted child. A record's `adopted` field now stands for `heldByAdoption` in `src/core/acquisition.ts`, and a new `byAdoption` field keeps the record's `origin`.

`ResumeStart` clears `adopted`, so `WatcherLearn` takes a `/clear` under the same id. relay-register writes the child's relay record whole, so the far parent's adopted claim under that id gives way to the started child's record. `Earlier` reads `byAdoption`, as `resumableAdoption` reads `origin`, and an adoption that takes the session up again sets `adopted`. The replays are in `test/integration/spawn-resume.test.ts` and `test/integration/retire.test.ts`.

A resumed adopted child can now take new sessions, so the ghosts take far more values. The settled configurations of the invariants that don't read a ghost declare `VIEW NoGhosts`, which leaves the ghosts out of a state's identity. The ghosts never steer the system, so the view checks the same behaviours. Without it, `ClaimsSettled-RouteToWatcher.cfg` passed a 10G ceiling.

| Invariant | All three on | All three off | One condition alone | Verdict |
| --- | --- | --- | --- | --- |
| `FarClaimCurrent` | Breaks | Breaks | Needs none | **Model stricter than the code can keep.** herdr changes a pane's session in one step, and the far parent's watcher responds on its next step. Since #222, that step ends the child and runs `relay-cleanup`, so the lag lasts one step. At 0.1.9, `EMPIRICAL.md` saw a stale claim until the pane closed, because no step ended it then. |
| `NoPaneTwoParents` | Breaks | Breaks | Needs none | **Model stricter**, with the same one-step lag: the far record shows a session the pane no longer runs. `NoPaneTwoParentsCurrent` states what the code can keep. `EMPIRICAL.md` saw this live at 0.1.9, before #222, when the far child never left. |
| `PaneOneLiveChild` | Breaks | Breaks | Needs none | **Model stricter**, as `NoPaneTwoParents`. |
| `NoPaneTwoParentsCurrent` | Breaks | Breaks | Needs none | **Code wrong, during an outage, for a started child only.** Since #257, a far parent sends each adopted claim again when its relay comes up (`Reconfirm`), and a refusal ends the child. The settled breach that remains needs a far parent's started child: `ResumeCheck` and `ResumeStart` for `f1`, its harness ends, the session runs again by hand in that pane, and `LocalAdopt` takes it. During an outage `f1` never sees the harness end, and its record matches the pane again. The pane's machine knows that the child's adapter connection closed, but nothing asks it once the relay is back. |
| `PaneOneLiveChildCurrent` | Breaks | Breaks | Needs none | **Code wrong**, with the same cause as `NoPaneTwoParentsCurrent`. |
| `IdStableBySession` | Breaks | Breaks | Needs none | **Invariant open for discussion since #256.** A resumed adopted child now counts as a started child, and its id follows its process across a `/clear`. The breach that remains needs that step: `LocalAdopt`, the harness quits, a resume, a `/clear`, the first session resumed by hand in another pane, `LocalAdopt` there. The child id now stands for the process in the first pane, so the session in the second pane gets a new id. Ruling out resumed adopted children, the invariant holds. |
| `IdStableInPane` | Breaks | Breaks | Needs none | **Open for discussion since #256**, through the same step as `IdStableBySession`. |
| `OneSessionPerId` | Breaks | Breaks | Needs none | **Open for discussion since #256.** The breach needs a resumed adopted child that took a second session as a started child, and then another pane adopts that second session. The record tracks one session at a time, but over its life the id covers two. With resuming an adopted child ruled out, the invariant holds. |
| `RouteToWatcher` | Breaks | **Holds**, 127,767 states under `VIEW NoGhosts` | `CleanupFails` breaks it. No breach in 200 s with `HandResumes` or `AnswersLost` alone | **Code wrong, after a failed cleanup.** An adopted claim stays after a `relay-cleanup` that failed, and the far daemon has no retry or expiry for it, which #258 tracks. A started child no longer leaves this residue, because its hold ends with its connection. |
| `RouteUnambiguous` | Breaks | **Holds**, 127,767 states under `VIEW NoGhosts` | `CleanupFails` breaks it, through the same residue. `HandResumes` breaks it after the session runs in two panes | **Code wrong after a failed cleanup**, with the same cause as `RouteToWatcher`. Before issue #244, the settled configuration also broke through `ComeBack`. |
| `SessionOnePane` | Breaks | **Holds**, 127,767 states under `VIEW NoGhosts` | `HandResumes` breaks it. No breach in 200 s with `CleanupFails` alone | **Not a code defect.** A person resumes the session by hand between the resume's check and its start. The code takes the session's lock, which a person's shell doesn't take. |

`ClaimsNoHandResume-SessionOnePane.cfg` turned off `HandResumes` alone, at three ids. On 2026-11-27 it filled a 32 GB machine. `ClaimsSettled-SessionOnePane.cfg` replaces it.

### Invariants whose wording changed

These invariants now count only adopted claims, since `relay` also records the started children's connections. A connection has no session, and `adoptedParentOf` routes only through adopted claims. A reviewer of the model should read these first, because the change narrows what they say:

- `FarClaimCurrent`: `r.adopted => paneSession[r.pane] = r.session`.
- `RouteUnambiguous`: the candidates from `relay` include only adopted claims.
- `RouteToWatcher`: it applies to an adopted claim only.

Before issue #244, every record in `relay` was an adopted claim. For every state reachable in the earlier model, each invariant says what it said before.

## Lifecycle, delivery, release and crossing at f3fe3a7

A comparison on 2026-11-28 set the four specs against the code at f3fe3a7. `Lifecycle.tla`, `Delivery.tla` and `Release.tla` still described 2645cf4, so each changed action now follows the code, and its comment points to the pull request. `Crossing.tla` is new.

Each invariant keeps its meaning. `EntersOnce` now counts a brief's copies together, as the earlier spec counted its pushes and typed copies together. Every fix behind a changed verdict merged after 0.1.9. The fleet used 0.1.9 in the runs recorded in `EMPIRICAL.md`, so no verdict here contradicts what those runs saw.

### Actions removed, changed and added

- **Restart.** `LetGo` keeps the old pane on the record and sets the closing mark (#213). `CloseOk` names the new pane in the same step as the close. `CloseErr` reads herdr's pane list. A pane still listed undoes the restart. A pane gone continues it. An unreadable list logs `unknown`. `RelayLost` writes `restartInDoubt`, and the new `Learn` clears it using the far daemon's saved answer (#214). The new `ClosingExpires` is the watcher's exit once the closing mark runs out.
- **Reap.** `ReapCheck` became `ReapLock`, which takes the child lock (#225). `ReapRemove` reads the record again first, and the new `ReapFinish` writes the outcome. `ReapDie` is a daemon that stops mid-reap. The lock keeps a dead pid. `ResumeClear` became `ResumeLock` and `ResumeClear`, with the guard that the code applies: it refuses only a worktree recorded as removed that no longer exists.
- **Workspace.** `RelList` and `RelClose` share one turn with every `SpawnInto` in the same daemon (#225). `SpawnInto` opens a new workspace when herdr has none. `UnturnedOpeners` allows an opener that skips the turn.
- **Delivery.** `AckTimeout` no longer types (#217, #221): the copy waits for the hello replay. `ModelTakes` split into `Enter`, `Read` and `ModelTurn`, because a read can arrive with no turn (#176, #246). `Record` needs a read and a turn since that copy's push began (#216). A second copy goes out only when the first copy got its answer and its read never came (#248). New: `Replay`, `Deadline`, `ReadOnly` and `NotTaken` (`BriefNotTaken`). When a copy's session is missing, herdr types it.
- **Release.** `FinishRelease` became `MergeRelease`, `Stage` and `Approve`. `Stage` is check 2 over the pull requests the release commit contains (#223). Both checks refuse a note under a published version unless that version's release commit contains its pull requests (#260).
- **Crossing.** All new: the carry from the lock to the commit (`CStart` to `CCommit`), the rollback (`RB1` to `RB4`, `RBFail`), a daemon that stops and starts (`Stop`, `Start`), the next daemon's recovery (`RBegin` to `RFail`), herdr reporting a harness (`Detect`), the watcher's exit and another starter (`OtherResume`). A self-teleport (#251, #252) records its request and runs the same carry once its turn ends, so it leaves the step list unchanged.

`Claims.tla` stays as it was. The pull requests in the list either changed it already (#222, #230, #236, #237, #259) or do not change what it models. The departures list (#261) and the relay drain from a departure host (#239) change which machine a report comes from, not who claims a pane. The daemon lock's `sshAgent` (#254) only appears in reports, and no decision reads it.

### Verdicts

| Invariant | Verdict |
| --- | --- |
| `RestartLeavesTrace` | **Model stricter than the code's design.** #213 removed the old `CloseErr` trace. A daemon that stops between the close and the start breaks it now. Nothing re-arms that restart, and nothing writes `restartFailed`. The watcher marks the child exited once the closing mark runs out, so the parent hears about an exit and never about a failed restart. |
| `RecordNamesPane` | **Code wrong on the far path only.** On this machine, the record gets the new pane in the same step as the close, so nothing breaks the invariant there. On the far path a lost answer leaves `restartInDoubt`, which `Learn` settles. A far daemon that stops before it keeps its answer leaves the doubt forever, because `restartInDoubt` has no expiry, and the watcher ignores the child while it lasts. |
| `LiveWorktreeKept` | **Code wrong, in a narrow window.** The old trace no longer exists: reap holds the child lock and reads the record again. If a daemon stops after `git worktree remove` and before it writes the outcome, the lock keeps a dead pid. The next resume takes that lock. Its guard refuses only a worktree that retirement recorded as removed (`resume.ts:158`), so the child resumes into a missing directory. A reap that holds the lock past 5 minutes reaches the same end. |
| `LiveWorkspaceKept` | **Holds within one daemon.** The workspace turn closes the old trace. Some openers stand outside the turn. A far daemon's `restartForRelay` opens a tab there. A second daemon on one home does too. A person can, as well. Real herdr 0.9.5 removes an empty workspace, as `EMPIRICAL.md` shows, so the premise fails there too. |
| `TakenMeansTurn` | **Code permissive, needs a stray status.** The turn signal does not identify a message, and a read can come without a turn. A `working` that the brief did not cause, plus a read, writes `takenAt`. Without a stray status, it holds. In 80 s of idle harnesses, the runs in `EMPIRICAL.md` saw only `idle`. |
| `EntersOnce` | **Code wrong, narrowly, and a resend by design.** A new adapter process says hello while a copy still waits in the harness's queue. It checks the transcript, and it pushes the copy again because the transcript lacks it. Separately, `DeliveryOneAdapterSessionUp` shows the resend that #248 keeps. A copy that entered, but whose read took longer than 20 s, gets a second copy. #248 accepts that trade against `BriefNotTaken`. |
| `ShippedHasNote` | **Holds.** Check 2 reads the pull requests the release commit contains, so a merge between the checks cannot get into a release unnoted. |
| `NoNoteUnderPublished` | **Model stricter.** The release script checks notes only during a release, so a note can land under a version published between its opening and its merge. `NoReleaseOverStaleNote` holds: the next release refuses it. |
| `SessionOnePlace` | **Code wrong.** A carry takes the child lock and not the session lock, so another parent's `agent_spawn` resume by session id can start the session on the source between the stop and the start at the destination. A session lock in the carry closes that window while the daemon runs, but not after it stops, since the lock then holds a dead pid (`CrossingNoHandSessionLock`). With no other starter at all (`CrossingAlone`), it still breaks. |
| `RecordNeverStranded` | **Code wrong.** A rollback writes the original record, which has no mark, and then `resumeChild` writes `paneId: ""` with no `exitedAt`. Recovery does the same after it deletes the mark. A daemon that stops then leaves a record that has none of a pane, an exit, a mark or `crossingFailed`. The watcher skips a record with no pane (`watcher.ts:366`), so it never repairs the record. The same write in any resume opens the same window. |
| `CopyAccounted` | **Code wrong, a leak.** The import writes files before the mark lists them, so a daemon that stops between the two leaves files that neither a rollback nor a recovery knows about. |
| `LeftPlaceRecorded` | **Holds.** Both the commit and recovery's finish record the departure in the write that removes the mark. |

### The disagreement that matters

`CrossingAlone-SessionOnePlace` breaks without a person or another parent. A carry types the launch line on the destination, and the daemon stops before herdr reports the session there. The next daemon's recovery asks the destination whether the session runs there.

A no from the destination sends recovery down the undo path: it points the record at the source and resumes the session there. Meanwhile the destination's harness comes up too, so the session runs on two machines.

The record lists only the source, and so nobody watches the copy on the destination. Recovery reads "herdr has not reported it" as "it doesn't run there". A fix would record a stage before `startHarness` and have recovery close the destination's tab before it resumes on the source.

## What the model is not

The specs came from the code by hand, at `origin/main` 2645cf4 and again at f3fe3a7, and the checker has not seen a recorded run. `everystate conform -trace FILE.jsonl SPEC.tla` checks a log of the real system against the spec, which answers a different question: not whether a bad state is reachable, but whether what happened was legal. The logs the daemon writes today record outcomes, not steps, so a useful conformance run would need a trace of steps first.

Every invariant that breaks here is a statement about the model. To turn one into a statement about the code, write the test that replays its trace and watch it fail. That failure is the proof, and the model is where it starts.
