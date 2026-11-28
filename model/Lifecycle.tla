---- MODULE Lifecycle ----
\* Bellwether restart, retire (reap) against resume, and workspace release, at 2645cf4.
\* Invariants 3, 4 and 7 of the fleet brief. The three parts share no variable, so
\* each counterexample stays in one part.
EXTENDS Naturals

CONSTANTS HerdrKeepsEmpty   \* herdr leaves a workspace in place when its last tab closes

VARIABLES
  \* -- restart of one child, restart.ts:402-519 and the far path 620-699 --
  oldAlive, newAlive,  \* herdr panes; the session runs in whichever is alive and started
  started,             \* the harness runs the session in the new pane
  recPane,             \* the record's paneId: "old", "new" or "none"
  failed,              \* restartFailed on the record
  logged,              \* a line in the parent's restart.log
  rstage,
  \* -- reap of one exited child's worktree, against a resume of it, retire.ts:244-348 --
  cExited, procInW, wtExists, reapStage, resStage,
  \* -- release of a workspace the child owns, workspace.ts:183-200 --
  wsExists, wsTabs, liveInWs, relStage, spStage

rVars == <<oldAlive, newAlive, started, recPane, failed, logged, rstage>>
wVars == <<cExited, procInW, wtExists, reapStage, resStage>>
sVars == <<wsExists, wsTabs, liveInWs, relStage, spStage>>
vars == <<rVars, wVars, sVars>>

Init ==
  /\ oldAlive = TRUE /\ newAlive = FALSE /\ started = FALSE /\ recPane = "old"
  /\ failed = FALSE /\ logged = FALSE /\ rstage = "idle"
  /\ cExited = TRUE /\ procInW = FALSE /\ wtExists = TRUE /\ reapStage = "idle" /\ resStage = "idle"
  /\ wsExists = TRUE /\ wsTabs = 1 /\ liveInWs = FALSE /\ relStage = "idle" /\ spStage = "idle"

\* ---------------- Restart (invariant 4) ----------------
\* 1. openReturnTab: the new tab opens first (f080cfa). A failure here changes nothing.
OpenNew == rstage = "idle" /\ newAlive' = TRUE /\ rstage' = "opened"
           /\ UNCHANGED <<oldAlive, started, recPane, failed, logged>> /\ UNCHANGED <<wVars, sVars>>
\* 2. The record lets go of the old pane, restart.ts:436-443.
LetGo == rstage = "opened" /\ recPane' = "none" /\ rstage' = "letgo"
         /\ UNCHANGED <<oldAlive, newAlive, started, failed, logged>> /\ UNCHANGED <<wVars, sVars>>
\* 3. tabClose(oldTab), restart.ts:446.
CloseOk == rstage = "letgo" /\ oldAlive' = FALSE /\ rstage' = "closed"
           /\ UNCHANGED <<newAlive, started, recPane, failed, logged>> /\ UNCHANGED <<wVars, sVars>>
\* 3'. tabClose throws: undoChildTab, old ids restored, no log (448-456). The tab may have
\* closed anyway, as with a 5 s herdr timeout (herdr-client.ts:13).
CloseErr(closedAnyway) ==
  /\ rstage = "letgo"
  /\ oldAlive' = ~closedAnyway
  /\ newAlive' = FALSE /\ recPane' = "old" /\ rstage' = "done"
  /\ UNCHANGED <<started, failed, logged>> /\ UNCHANGED <<wVars, sVars>>
\* 4. startHarness in the new pane, then markRestarted and the "restarted" line (463-519).
StartOk == rstage = "closed" /\ started' = TRUE /\ recPane' = "new" /\ logged' = TRUE /\ rstage' = "done"
           /\ UNCHANGED <<oldAlive, newAlive, failed>> /\ UNCHANGED <<wVars, sVars>>
\* 4'. The start fails: undo the new tab, markRestartFailed, a "failed" line (487-496).
StartFail == rstage = "closed" /\ newAlive' = FALSE /\ recPane' = "old" /\ failed' = TRUE /\ logged' = TRUE
             /\ rstage' = "done" /\ UNCHANGED <<oldAlive, started>> /\ UNCHANGED <<wVars, sVars>>
\* The daemon dies mid-act. Nothing re-arms the act: restartRequestedAt is already gone.
Crash == rstage \in {"opened", "letgo", "closed"} /\ rstage' = "done"
         /\ UNCHANGED <<oldAlive, newAlive, started, recPane, failed, logged>> /\ UNCHANGED <<wVars, sVars>>
\* Far restart: the relay call times out or ssh drops after the far daemon closed the old
\* pane. The parent runs restore() and writes nothing (restart.ts:664-669). The far side
\* may have started the session, or died with its in-memory held record.
RelayLost(farStarted) ==
  /\ rstage = "closed"
  /\ started' = farStarted /\ newAlive' = farStarted
  /\ recPane' = "old" /\ rstage' = "done"
  /\ UNCHANGED <<oldAlive, failed, logged>> /\ UNCHANGED <<wVars, sVars>>

Restart == OpenNew \/ LetGo \/ CloseOk \/ CloseErr(TRUE) \/ CloseErr(FALSE) \/ StartOk \/ StartFail
           \/ Crash \/ RelayLost(TRUE) \/ RelayLost(FALSE)

\* ---------------- Reap against resume (invariant 7) ----------------
\* reapChild reads the child once (retire.ts:246): exited, retirement pending, pane gone.
ReapCheck == reapStage = "idle" /\ cExited /\ ~procInW /\ reapStage' = "checked"
             /\ UNCHANGED <<cExited, procInW, wtExists, resStage>> /\ UNCHANGED <<rVars, sVars>>
\* After the git and gh awaits, busy() looks for a process in the worktree (312-322).
ReapBusy == reapStage = "checked" /\ reapStage' = (IF procInW THEN "refused" ELSE "busyok")
            /\ UNCHANGED <<cExited, procInW, wtExists, resStage>> /\ UNCHANGED <<rVars, sVars>>
\* removeWorktree, with no second read of exitedAt (326).
ReapRemove == reapStage = "busyok" /\ wtExists' = FALSE /\ reapStage' = "removed"
              /\ UNCHANGED <<cExited, procInW, resStage>> /\ UNCHANGED <<rVars, sVars>>
\* resumeChild under the child lock, which reap never takes: refuse a missing cwd
\* (resume.ts:142), clear exitedAt and the retirement (186, 194), open the tab, start.
ResumeClear == resStage = "idle" /\ cExited /\ wtExists /\ cExited' = FALSE /\ resStage' = "cleared"
               /\ UNCHANGED <<procInW, wtExists, reapStage>> /\ UNCHANGED <<rVars, sVars>>
ResumeTab == resStage = "cleared" /\ procInW' = wtExists /\ resStage' = "tab"
             /\ UNCHANGED <<cExited, wtExists, reapStage>> /\ UNCHANGED <<rVars, sVars>>

Reap == ReapCheck \/ ReapBusy \/ ReapRemove \/ ResumeClear \/ ResumeTab

\* ---------------- Workspace release (invariant 3) ----------------
\* The owner's tab closes (watcher pane_closed / tab_closed, or agent_stop).
OwnerCloses == relStage = "idle" /\ wsTabs > 0 /\ wsTabs' = wsTabs - 1 /\ relStage' = "closing"
               /\ wsExists' = (HerdrKeepsEmpty \/ wsTabs - 1 > 0)
               /\ UNCHANGED <<liveInWs, spStage>> /\ UNCHANGED <<rVars, wVars>>
\* releaseWorkspace: tabList (await) ...
RelList == relStage = "closing" /\ relStage' = (IF wsTabs = 0 THEN "listed" ELSE "kept")
           /\ UNCHANGED <<wsExists, wsTabs, liveInWs, spStage>> /\ UNCHANGED <<rVars, wVars>>
\* ... then workspaceClose, with no lock and no second look.
RelClose == relStage = "listed" /\ wsExists /\ wsExists' = FALSE /\ wsTabs' = 0 /\ relStage' = "done"
            /\ UNCHANGED <<liveInWs, spStage>> /\ UNCHANGED <<rVars, wVars>>
\* A spawn, resume or restart that returnPlacement sends to this workspace opens a tab.
SpawnInto == spStage = "idle" /\ wsExists /\ wsTabs' = wsTabs + 1 /\ liveInWs' = TRUE /\ spStage' = "in"
             /\ UNCHANGED <<wsExists, relStage>> /\ UNCHANGED <<rVars, wVars>>

Workspace == OwnerCloses \/ RelList \/ RelClose \/ SpawnInto

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
