---- MODULE Lifecycle ----
\* Bellwether restart, retire (reap) against resume, and workspace release.
\* Written at 2645cf4 and brought up to f3fe3a7: the restart after #213 and #214,
\* the reap under the child lock after #225, and the workspace turn after #225.
\* Invariants 3, 4 and 7 of the fleet brief. The three parts share no variable, so
\* each counterexample stays in one part.
EXTENDS Naturals

CONSTANTS HerdrKeepsEmpty,   \* herdr leaves a workspace in place when its last tab closes
          UnturnedOpeners,   \* a tab opener outside this daemon's workspace turn: a far daemon's
                             \* restartForRelay, a second daemon on the same home, or a person
          LockAgeTakeover,   \* a resume takes the child lock from a live reap past
                             \* CHILD_LOCK_MAX_AGE_MS (child-lock.ts:15), 5 min
          FarRestarts        \* the restarted child may run on another machine (relay-restart)

VARIABLES
  \* -- restart of one child, restartInPlace (restart.ts:454-589) and the far path (:620-767) --
  far,                 \* the child runs on another machine: the parent asks relay-restart there
  oldAlive, newAlive,  \* herdr panes; the session runs in whichever is alive and started
  started,             \* the harness runs the session in the new pane
  recPane,             \* the record's paneId: "old" or "new"
  closing,             \* the record's closing mark (restart.ts:490-496): the watcher skips the child
  failed,              \* restartFailed on the record
  logged,              \* a line in the parent's restart.log
  doubt,               \* restartInDoubt on the record (#214)
  farKept,             \* the far daemon kept its answer in its relay outbox (server.ts:993-1001)
  exitSeen,            \* the watcher marked the child exited once closing ran out (watcher.ts:366-370)
  rstage,
  \* -- reap of one exited child's worktree, against a resume of it, retire.ts:401-585 --
  cExited, procInW, wtExists, outcome, lock, holderDead, reapStage, resStage,
  \* -- release of a workspace the child owns, workspace.ts:199-242 --
  wsExists, wsTabs, liveInWs, relStage, spStage, turn

rVars == <<far, oldAlive, newAlive, started, recPane, closing, failed, logged, doubt, farKept, exitSeen, rstage>>
wVars == <<cExited, procInW, wtExists, outcome, lock, holderDead, reapStage, resStage>>
sVars == <<wsExists, wsTabs, liveInWs, relStage, spStage, turn>>
vars == <<rVars, wVars, sVars>>

Init ==
  /\ far \in (IF FarRestarts THEN BOOLEAN ELSE {FALSE})
  /\ oldAlive = TRUE /\ newAlive = FALSE /\ started = FALSE /\ recPane = "old" /\ closing = FALSE
  /\ failed = FALSE /\ logged = FALSE /\ doubt = FALSE /\ farKept = FALSE /\ exitSeen = FALSE /\ rstage = "idle"
  /\ cExited = TRUE /\ procInW = FALSE /\ wtExists = TRUE /\ outcome = "none" /\ lock = "free"
  /\ holderDead = FALSE /\ reapStage = "idle" /\ resStage = "idle"
  /\ wsExists = TRUE /\ wsTabs = 1 /\ liveInWs = FALSE /\ relStage = "idle" /\ spStage = "idle" /\ turn = "free"

\* ---------------- Restart (invariant 4) ----------------
\* The local path writes the record itself. The far path writes nothing until the
\* answer comes: the daemon there runs the same steps against its own registry.

\* 1. openRestartTab: the new tab opens first. A failure here changes nothing.
OpenNew == rstage = "idle" /\ newAlive' = TRUE /\ rstage' = "opened"
           /\ UNCHANGED <<far, oldAlive, started, recPane, closing, failed, logged, doubt, farKept, exitSeen>>
  /\ UNCHANGED <<wVars, sVars>>
\* 2. The record keeps the old pane and takes the closing mark (restart.ts:490-496), so the
\* watcher ignores the close. Before #213 it let go of the pane here.
LetGo == rstage = "opened" /\ closing' = ~far /\ rstage' = "letgo"
           /\ UNCHANGED <<far, oldAlive, newAlive, started, recPane, failed, logged, doubt, farKept, exitSeen>>
  /\ UNCHANGED <<wVars, sVars>>
\* 3. tabClose answers, and with no await the record names the new pane (restart.ts:503, 530-538).
CloseOk == rstage = "letgo" /\ oldAlive' = FALSE /\ rstage' = "closed"
             /\ recPane' = (IF far THEN recPane ELSE "new") /\ closing' = FALSE
             /\ UNCHANGED <<far, newAlive, started, failed, logged, doubt, farKept, exitSeen>>
  /\ UNCHANGED <<wVars, sVars>>
\* 3'. tabClose throws. The tab may have closed anyway, as with a 5 s herdr timeout. #213 reads
\* herdr's pane list (stillListed, restart.ts:507): still listed undoes and refuses; gone goes on
\* as CloseOk; an unreadable list undoes, logs "unknown" and refuses (:515-519).
CloseErr(closedAnyway, listOk) ==
  /\ rstage = "letgo"
    /\ oldAlive' = ~closedAnyway
    /\ (IF listOk /\ closedAnyway
        THEN /\ recPane' = (IF far THEN recPane ELSE "new") /\ closing' = FALSE /\ rstage' = "closed"
             /\ UNCHANGED <<newAlive, logged>>
        ELSE /\ newAlive' = FALSE /\ closing' = FALSE /\ rstage' = "done" /\ logged' = ~listOk
             /\ UNCHANGED recPane)
    /\ UNCHANGED <<far, started, failed, doubt, farKept, exitSeen>>
  /\ UNCHANGED <<wVars, sVars>>
\* 4. startHarness in the new pane, then markRestarted and the "restarted" line (:528-586).
\* On the far path the far daemon keeps its answer (farKept) and the parent writes on the reply.
StartOk == rstage = "closed" /\ started' = TRUE /\ recPane' = "new" /\ logged' = TRUE /\ rstage' = "done"
             /\ farKept' = far
             /\ UNCHANGED <<far, oldAlive, newAlive, closing, failed, doubt, exitSeen>>
  /\ UNCHANGED <<wVars, sVars>>
\* 4'. The start fails: undo the new tab, markRestartFailed, a "failed" line (:555-563).
StartFail == rstage = "closed" /\ newAlive' = FALSE /\ recPane' = "old" /\ failed' = TRUE /\ logged' = TRUE
               /\ rstage' = "done" /\ farKept' = far
               /\ UNCHANGED <<far, oldAlive, started, closing, doubt, exitSeen>>
  /\ UNCHANGED <<wVars, sVars>>
\* The daemon that runs the act dies. Nothing re-arms it: restartRequestedAt went at LetGo.
Crash == rstage \in {"opened", "letgo", "closed"} /\ rstage' = "done"
           /\ UNCHANGED <<far, oldAlive, newAlive, started, recPane, closing, failed, logged, doubt, farKept, exitSeen>>
  /\ UNCHANGED <<wVars, sVars>>
\* Far: the relay answer is lost after the far daemon closed the old pane (#214). The parent
\* writes restartInDoubt and logs "unknown" (restart.ts:746-767). The far side may have started
\* the session and kept its answer, or died with the act in memory and kept nothing.
RelayLost(farStarted, farLives) ==
  /\ far /\ rstage = "closed"
    /\ started' = farStarted /\ newAlive' = farStarted
    /\ doubt' = TRUE /\ logged' = TRUE /\ farKept' = farLives /\ rstage' = "done"
    /\ UNCHANGED <<far, oldAlive, recPane, closing, failed, exitSeen>>
  /\ UNCHANGED <<wVars, sVars>>
\* The connection returns and the parent takes the kept answer (learnRelayRestart, :828-844).
Learn == /\ doubt /\ farKept
           /\ doubt' = FALSE
           /\ recPane' = (IF started THEN "new" ELSE "old")
           /\ failed' = ~started
           /\ UNCHANGED <<far, oldAlive, newAlive, started, closing, logged, farKept, exitSeen, rstage>>
  /\ UNCHANGED <<wVars, sVars>>
\* Once closing runs out, the watcher reconciles: a record whose pane runs no session exits
\* (watcher.ts:366-370, 416). A record in doubt is skipped (:362).
ClosingExpires == /\ rstage = "done" /\ ~far /\ ~doubt /\ ~exitSeen
                    /\ ~((recPane = "old" /\ oldAlive /\ ~started) \/ (recPane = "new" /\ newAlive /\ started))
                    /\ exitSeen' = TRUE /\ closing' = FALSE
                    /\ UNCHANGED <<far, oldAlive, newAlive, started, recPane, failed, logged, doubt, farKept, rstage>>
  /\ UNCHANGED <<wVars, sVars>>

Restart == OpenNew \/ LetGo \/ CloseOk \/ StartOk \/ StartFail \/ Crash \/ Learn \/ ClosingExpires
           \/ \E a, b \in BOOLEAN : CloseErr(a, b) \/ RelayLost(a, b)

\* ---------------- Reap against resume (invariant 7) ----------------
\* A lock is free, or its holder's pid is dead, or LockAgeTakeover lets an old one go (child-lock.ts:55-91).
Takeable == lock = "free" \/ holderDead \/ (LockAgeTakeover /\ lock = "reap")

\* reapChild takes the child lock and reads the record under it (retire.ts:407-425).
ReapLock == reapStage = "idle" /\ cExited /\ outcome = "none" /\ lock = "free"
              /\ lock' = "reap" /\ holderDead' = FALSE /\ reapStage' = "checked"
              /\ UNCHANGED <<cExited, procInW, wtExists, outcome, resStage>>
  /\ UNCHANGED <<rVars, sVars>>
\* After the git and gh awaits, busy() looks for a process in the worktree (:548-563).
ReapBusy == reapStage = "checked" /\ reapStage' = (IF procInW THEN "refused" ELSE "busyok")
              /\ outcome' = (IF procInW THEN "refused" ELSE outcome)
              /\ lock' = (IF procInW /\ lock = "reap" THEN "free" ELSE lock)
              /\ UNCHANGED <<cExited, procInW, wtExists, holderDead, resStage>>
  /\ UNCHANGED <<rVars, sVars>>
\* stillExited reads the record again (:569); with no await, removeWorktree begins (:575).
ReapRemove == reapStage = "busyok"
                /\ (IF cExited
                    THEN wtExists' = FALSE /\ reapStage' = "removed" /\ UNCHANGED lock
                    ELSE reapStage' = "skipped" /\ lock' = (IF lock = "reap" THEN "free" ELSE lock) /\ UNCHANGED wtExists)
                /\ UNCHANGED <<cExited, procInW, outcome, holderDead, resStage>>
  /\ UNCHANGED <<rVars, sVars>>
\* finish writes retireOutcome and lets go of the lock.
ReapFinish == reapStage = "removed" /\ outcome' = "removed" /\ reapStage' = "done"
                /\ lock' = (IF lock = "reap" THEN "free" ELSE lock)
                /\ UNCHANGED <<cExited, procInW, wtExists, holderDead, resStage>>
  /\ UNCHANGED <<rVars, sVars>>
\* The daemon dies during the reap. Its lock file stays, with a dead pid in it.
ReapDie == reapStage \in {"checked", "busyok", "removed"} /\ reapStage' = "dead"
             /\ holderDead' = (lock = "reap")
             /\ UNCHANGED <<cExited, procInW, wtExists, outcome, lock, resStage>>
  /\ UNCHANGED <<rVars, sVars>>
\* resumeChild under the child lock (spawn-resume.ts:93). It refuses only a worktree that
\* retirement recorded as removed and that no longer exists (resume.ts:158-161), then clears
\* exitedAt and the retirement (:196-221), opens the tab and starts.
ResumeLock == resStage = "idle" /\ cExited /\ Takeable
                /\ lock' = "resume" /\ holderDead' = FALSE /\ resStage' = "locked"
                /\ UNCHANGED <<cExited, procInW, wtExists, outcome, reapStage>>
  /\ UNCHANGED <<rVars, sVars>>
ResumeClear == resStage = "locked"
                 /\ (IF outcome = "removed" /\ ~wtExists
                     THEN resStage' = "refused" /\ lock' = "free" /\ UNCHANGED <<cExited, outcome>>
                     ELSE cExited' = FALSE /\ outcome' = "none" /\ resStage' = "cleared" /\ UNCHANGED lock)
                 /\ UNCHANGED <<procInW, wtExists, holderDead, reapStage>>
  /\ UNCHANGED <<rVars, sVars>>
ResumeTab == resStage = "cleared" /\ procInW' = wtExists /\ resStage' = "tab" /\ lock' = "free"
               /\ UNCHANGED <<cExited, wtExists, outcome, holderDead, reapStage>>
  /\ UNCHANGED <<rVars, sVars>>

Reap == ReapLock \/ ReapBusy \/ ReapRemove \/ ReapFinish \/ ReapDie \/ ResumeLock \/ ResumeClear \/ ResumeTab

\* ---------------- Workspace release (invariant 3) ----------------
\* The owner's tab closes (watcher pane_closed / tab_closed, or agent_stop).
OwnerCloses == relStage = "idle" /\ wsTabs > 0 /\ wsTabs' = wsTabs - 1 /\ relStage' = "closing"
                 /\ wsExists' = (HerdrKeepsEmpty \/ wsTabs - 1 > 0)
                 /\ UNCHANGED <<liveInWs, spStage, turn>>
  /\ UNCHANGED <<rVars, wVars>>
\* releaseWorkspace takes the workspace's turn (inWorkspaceTurn, workspace.ts:229), then tabList.
RelList == relStage = "closing" /\ turn = "free" /\ turn' = "release"
             /\ relStage' = (IF wsExists /\ wsTabs = 0 THEN "listed" ELSE "kept")
             /\ UNCHANGED <<wsExists, wsTabs, liveInWs, spStage>>
  /\ UNCHANGED <<rVars, wVars>>
\* ... then workspaceClose in the same turn, with no second look.
RelClose == relStage = "listed" /\ wsExists' = FALSE /\ wsTabs' = 0 /\ relStage' = "done" /\ turn' = "free"
              /\ UNCHANGED <<liveInWs, spStage>>
  /\ UNCHANGED <<rVars, wVars>>
RelKept == relStage = "kept" /\ relStage' = "done" /\ turn' = "free"
             /\ UNCHANGED <<wsExists, wsTabs, liveInWs, spStage>>
  /\ UNCHANGED <<rVars, wVars>>
\* A spawn, resume or restart that returnPlacement sends to this workspace opens a tab inside
\* the turn (workspace.ts:132-133), or in a new workspace when herdr has none (:151-157).
\* An opener outside the turn skips the wait.
SpawnInto == /\ spStage = "idle"
               /\ (turn = "free" \/ UnturnedOpeners)
               /\ (IF wsExists THEN wsTabs' = wsTabs + 1 /\ liveInWs' = TRUE ELSE liveInWs' = FALSE /\ UNCHANGED wsTabs)
               /\ spStage' = "in"
               /\ UNCHANGED <<wsExists, relStage, turn>>
  /\ UNCHANGED <<rVars, wVars>>

Workspace == OwnerCloses \/ RelList \/ RelClose \/ RelKept \/ SpawnInto

Next == Restart \/ Reap \/ Workspace

Spec == Init /\ [][Next]_vars

\* ---- Invariants ----
\* 4. A finished or abandoned restart leaves the session in a pane, or a record of the failure.
SessionRunning == (oldAlive /\ ~started) \/ (newAlive /\ started)
RestartLeavesTrace == rstage = "done" => (SessionRunning \/ failed \/ logged)
\* 4, stronger: the record names the pane the session runs in.
RecordNamesPane == rstage = "done" /\ SessionRunning =>
                     ((recPane = "old" /\ oldAlive /\ ~started) \/ (recPane = "new" /\ newAlive /\ started))
\* 7. A worktree a live child works in is never removed.
LiveWorktreeKept == ~cExited => wtExists
\* 3. A workspace holding a live session is never removed.
LiveWorkspaceKept == liveInWs => wsExists
====
