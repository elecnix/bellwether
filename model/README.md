# Model of the daemon's state and mutations

A TLA+ model of what the daemon holds and what the acts do to it: machines, sessions, panes, workspaces, children, claims, relay links, briefs, messages, reports, restarts, resumes, moves and retirements.

It exists to answer one kind of question before code is written: **which sequences of steps can leave a child watched by two parents, a session with no pane and no trace, a brief recorded as taken but never read, or a release shipping a change no note mentions.** Each of those happened once, on a real fleet, before the model existed.

`everystate` checks it. It is a TLA+ model checker in Rust, so no Java is needed:

```sh
npm install -g everystate     # or: brew install mattzcarey/tap/everystate
./run-all.sh
```

`run-all.sh` runs one configuration per invariant and prints one line each: the exit code, then the invariant's name, the number of distinct states and the action names of the shortest trace. Exit `0` means the invariant holds at that bound, exit `12` means a reachable state breaks it. Set `EVERYSTATE` if the binary is somewhere else.

## What each file is

| File | What it models |
| --- | --- |
| `Claims.tla` | Who watches which pane: local and far adoption, a session changing under a pane, resume checks, and the relay's claims |
| `Lifecycle.tla` | Panes, workspaces and worktrees: restarts, crashes during a restart, reaping, resumes, and herdr removing an empty workspace |
| `Delivery.tla` | A brief and a message: the push, the adapter's receipt, a stray status, a turn, a read, an ack timeout and a resend |
| `Release.tla` | A release: opening the window, merging pull requests during it, finishing it, and the note each merged change needs |
| `<Spec>.cfg` | The full configuration for one spec, used while writing it |
| `<Spec>-<Invariant>.cfg` | One invariant and nothing else, so a run reports that invariant's verdict instead of stopping at the first breach |
| `run-all.sh` | Runs every one-invariant configuration |

## The invariants

| Invariant | What it says | Verdict |
| --- | --- | --- |
| `RouteToWatcher` | A pane's reports reach the parent whose record names it | **Breaks after one step**, `FarAdopt` |
| `NoPaneTwoParents` | No pane is watched by two parents | Breaks: `FarAdopt`, `SessionChange`, `LocalAdopt` |
| `PaneOneLiveChild` | A pane holds at most one live child | Breaks, same trace |
| `IdStableBySession` | A child's id does not change while its session is the same | Breaks: `LocalAdopt`, `SessionChange` twice, `LocalAdopt` |
| `IdStableInPane` | A child's id does not change while its pane is the same | Breaks, 57137 distinct states |
| `OneSessionPerId` | One child id names one session | Breaks: `LocalAdopt`, `SessionChange`, `Next` |
| `SessionOnePane` | A session runs in at most one pane | Breaks, 5619 distinct states |
| `FarClaimCurrent` | A far claim names the pane that holds the session | Breaks: `FarAdopt`, `SessionChange` |
| `RouteUnambiguous` | One pane's reports go to one parent | Breaks, 3875 distinct states |
| `RestartLeavesTrace` | A restart that closes a pane and fails leaves a record | Breaks: `OpenNew`, `LetGo`, `CloseErr` |
| `RecordNamesPane` | A record names a pane that exists | Breaks: `OpenNew`, `LetGo`, `Crash` |
| `LiveWorktreeKept` | A worktree a live child works in is never removed | Breaks: `ReapCheck`, `ReapBusy`, `ResumeClear`, `ReapRemove` |
| `LiveWorkspaceKept` | A workspace holding a live session is never removed | Breaks: `OwnerCloses`, `RelList`, `SpawnInto`, `RelClose`; **holds** when herdr removes an empty workspace |
| `TakenMeansTurn` | A brief is taken only if the model began a turn on it | Breaks: `Push`, `AdapterQueue`, `Stray`, `Record`; **holds** with no stray status, with or without a resend |
| `EntersOnce` | A message enters a session exactly once | Breaks: `Push`, `AckTimeout`, `AdapterQueue` |
| `ShippedHasNote` | A merged pull request has a note in the release that ships it | Breaks: `Open`, `StartRelease`, `Merge`, `FinishRelease` |
| `NoNoteUnderPublished` | No note is filed under an already published version | Breaks: `Open`, `StartRelease`, `FinishRelease`, `Merge` |

Two configurations hold, and they earn their place: `LifecycleHerdrRemovesEmpty-LiveWorkspaceKept.cfg` and `DeliveryNoStrayNoResend-TakenMeansTurn.cfg`. Each shows what a breach depends on. The first needs herdr to keep an empty workspace; the second needs a `working` status that the brief did not cause, which `Stray` stands for.

With `StrayWorking = FALSE` and `MaxPushes = 2`, the checker doesn't find a breach, so a resend on its own leaves `TakenMeansTurn` intact. A fix that removes one assumption turns a breach into a hold, and the config file is where that is written down.

## What the model is not

The spec was written from the code by hand, at `origin/main` 2645cf4, and the checker has not seen a recorded run. `everystate conform -trace FILE.jsonl SPEC.tla` checks a log of the real system against the spec, which answers a different question: not whether a bad state is reachable, but whether what happened was legal. The logs the daemon writes today record outcomes, not steps, so a useful conformance run would need a trace of steps first.

Every invariant that breaks here is a statement about the model. To turn one into a statement about the code, write the test that replays its trace and watch it fail. That failure is the proof, and the model is where it starts.
