---- MODULE Crossing ----
\* A crossing: agent_move or agent_teleport of a live child from one machine to another
\* (carryChild, src/core/carry.ts:195-476), a daemon that stops part way, and the next daemon's
\* recovery of the interrupted crossing (recoverOne, src/core/recover-crossing.ts:86-180).
\* Written at f3fe3a7 for #240, #247, #251, #252 and #261. A self-teleport (#251, #252) records
\* teleportRequest and runs the same carry once its turn ends, so it adds no step here.
\* One child, one session, two machines. Every step below is separated from the next by an
\* await in the code, so a daemon can stop between any two.
EXTENDS Naturals, FiniteSets

CONSTANTS HandResumes,      \* a person starts the session by hand on a machine whose panes don't hold it
          PeerResumes,      \* another parent resumes the session by id (agent_spawn resume), which
                            \* takes the session lock (spawn-resume.ts:91) and checks its own machine
          CarrySessionLock  \* what-if: carry and recovery also take the session lock. FALSE is the code.

M == {"src", "dst"}
Active == {"checked", "imported", "copied", "verified", "closed", "stopped", "pointed", "checkedDst",
           "launched", "started", "rb", "rb2", "rb3", "rb4"}
RActive == {"readDst", "readSrc", "resume", "res2", "res3", "res4"}

VARIABLES
  run,        \* herdr on each machine: "none", "starting" (the launch line typed, herdr hasn't
              \* reported the session) or "running"
  host,       \* the record's host
  exited,     \* the record's exitedAt
  paneSet,    \* the record names a pane (resumeChild writes paneId "" before the tab, resume.ts:230)
  failed,     \* crossingFailed on the record
  departed,   \* the source is in the record's departures (#261)
  mark,       \* the record's moving mark: "none" or its stage
  markOld,    \* the daemon named in the mark has stopped (interrupted, recover-crossing.ts:54)
  tgt,        \* the copy on the destination: "none", "unlisted" (imported, not yet in the mark),
              \* "listed" (in the mark's files) or "kept" (committed)
  lock,       \* the child lock: "free", "carry" or "recover". A dead holder's lock is free.
  cpc,        \* carryChild's step, "idle", "dead" (its daemon stopped) or "done"
  rpc,        \* recoverOne's step
  daemon      \* "up" or "down"

vars == <<run, host, exited, paneSet, failed, departed, mark, markOld, tgt, lock, cpc, rpc, daemon>>

Init == /\ run = [m \in M |-> IF m = "src" THEN "running" ELSE "none"]
        /\ host = "src" /\ exited = FALSE /\ paneSet = TRUE /\ failed = FALSE /\ departed = FALSE
        /\ mark = "none" /\ markOld = FALSE /\ tgt = "none" /\ lock = "free"
        /\ cpc = "idle" /\ rpc = "idle" /\ daemon = "up"

Rec == <<host, exited, paneSet, failed, departed>>
Up == daemon = "up"

\* ---------------- carryChild ----------------
\* withChildLock (carry.ts:210), the refusals and leftover checks, then the mark (:326-342).
CStart == /\ Up /\ cpc = "idle" /\ lock = "free" /\ mark = "none" /\ ~exited /\ ~failed
          /\ host = "src" /\ run["src"] = "running"
          /\ lock' = "carry" /\ mark' = "checked" /\ markOld' = FALSE /\ cpc' = "checked"
          /\ UNCHANGED <<run, Rec, tgt, rpc, daemon>>
\* importSession writes the copy on the destination (:304) ...
CImport == /\ Up /\ cpc = "checked" /\ tgt' = "unlisted" /\ cpc' = "imported"
           /\ UNCHANGED <<run, Rec, mark, markOld, lock, rpc, daemon>>
\* ... and the mark lists its files once the import answers (:310).
CListFiles == /\ Up /\ cpc = "imported" /\ tgt' = "listed" /\ cpc' = "copied"
              /\ UNCHANGED <<run, Rec, mark, markOld, lock, rpc, daemon>>
\* verifyCopy, then the mark's stage and target session (:349).
CVerify == /\ Up /\ cpc = "copied" /\ mark' = "verified" /\ cpc' = "verified"
           /\ UNCHANGED <<run, Rec, tgt, markOld, lock, rpc, daemon>>
\* tabClose on the source (:353-358).
CClose == /\ Up /\ cpc = "verified" /\ run' = [run EXCEPT !["src"] = "none"] /\ cpc' = "closed"
          /\ UNCHANGED <<Rec, mark, markOld, tgt, lock, rpc, daemon>>
\* agentList: a pane still holding the session throws, and the rollback for "verified" puts the
\* record back with no restart (:361-364). Otherwise the stage is "stopped".
CStopCheck == /\ Up /\ cpc = "closed"
              /\ IF run["src"] = "none"
                 THEN mark' = "stopped" /\ cpc' = "stopped" /\ UNCHANGED <<Rec, tgt, lock>>
                 ELSE /\ mark' = "none" /\ tgt' = "none" /\ lock' = "free" /\ cpc' = "done"
                      /\ UNCHANGED Rec
              /\ UNCHANGED <<run, markOld, rpc, daemon>>
\* upsertChild(moved): host is the destination, exitedAt set (:377-384). The mark stays.
CPoint == /\ Up /\ cpc = "stopped" /\ host' = "dst" /\ exited' = TRUE /\ cpc' = "pointed"
          /\ UNCHANGED <<run, paneSet, failed, departed, mark, markOld, tgt, lock, rpc, daemon>>
\* resumeChild on the destination: holdsSession there only (resume.ts:162), then the record
\* with paneId "" and no exitedAt (:230).
CResCheck == /\ Up /\ cpc = "pointed"
             /\ IF run["dst"] /= "none"
                THEN cpc' = "rb" /\ UNCHANGED <<exited, paneSet>>
                ELSE exited' = FALSE /\ paneSet' = FALSE /\ cpc' = "checkedDst"
             /\ UNCHANGED <<run, host, failed, departed, mark, markOld, tgt, lock, rpc, daemon>>
\* The tab opens and startHarness types the launch line.
CLaunch == /\ Up /\ cpc = "checkedDst" /\ run' = [run EXCEPT !["dst"] = "starting"] /\ cpc' = "launched"
           /\ UNCHANGED <<Rec, mark, markOld, tgt, lock, rpc, daemon>>
\* The start fails before herdr reports the session: resumeChild undoes its own tab.
CLaunchFail == /\ Up /\ cpc \in {"checkedDst", "launched"} /\ run["dst"] /= "running"
               /\ run' = [run EXCEPT !["dst"] = "none"] /\ cpc' = "rb"
               /\ UNCHANGED <<Rec, mark, markOld, tgt, lock, rpc, daemon>>
\* herdr reports the session, the record names the pane, the stage is "started" (:390).
CStarted == /\ Up /\ cpc = "launched" /\ run["dst"] = "running"
            /\ paneSet' = TRUE /\ mark' = "started" /\ cpc' = "started"
            /\ UNCHANGED <<run, host, exited, failed, departed, markOld, tgt, lock, rpc, daemon>>
\* commit, relay-cleanup on the source, then one write: no mark, a departure (:449-456).
CCommit == /\ Up /\ cpc = "started" /\ tgt' = "kept" /\ mark' = "none" /\ departed' = TRUE
           /\ lock' = "free" /\ cpc' = "done"
           /\ UNCHANGED <<run, host, exited, paneSet, failed, markOld, rpc, daemon>>
\* Rollback after "stopped" (:391-445): discard the copy, upsertChild(original), which carries no
\* mark, and exitedAt; then resumeChild on the source.
RB1 == /\ Up /\ cpc = "rb" /\ tgt' = "none" /\ mark' = "none" /\ host' = "src" /\ exited' = TRUE
       /\ paneSet' = TRUE /\ cpc' = "rb2"
       /\ UNCHANGED <<run, failed, departed, markOld, lock, rpc, daemon>>
RB2 == /\ Up /\ cpc = "rb2"
       /\ IF run["src"] /= "none"
          THEN failed' = TRUE /\ lock' = "free" /\ cpc' = "done" /\ UNCHANGED <<exited, paneSet>>
          ELSE exited' = FALSE /\ paneSet' = FALSE /\ cpc' = "rb3" /\ UNCHANGED <<failed, lock>>
       /\ UNCHANGED <<run, host, departed, mark, markOld, tgt, rpc, daemon>>
RB3 == /\ Up /\ cpc = "rb3" /\ run' = [run EXCEPT !["src"] = "starting"] /\ cpc' = "rb4"
       /\ UNCHANGED <<Rec, mark, markOld, tgt, lock, rpc, daemon>>
RB4 == /\ Up /\ cpc = "rb4" /\ run["src"] = "running" /\ paneSet' = TRUE /\ lock' = "free" /\ cpc' = "done"
       /\ UNCHANGED <<run, host, exited, failed, departed, mark, markOld, tgt, rpc, daemon>>
RBFail == /\ Up /\ cpc \in {"rb3", "rb4"} /\ run["src"] /= "running"
          /\ run' = [run EXCEPT !["src"] = "none"] /\ failed' = TRUE /\ lock' = "free" /\ cpc' = "done"
          /\ UNCHANGED <<host, exited, paneSet, departed, mark, markOld, tgt, rpc, daemon>>

Carry == CStart \/ CImport \/ CListFiles \/ CVerify \/ CClose \/ CStopCheck \/ CPoint \/ CResCheck
         \/ CLaunch \/ CLaunchFail \/ CStarted \/ CCommit \/ RB1 \/ RB2 \/ RB3 \/ RB4 \/ RBFail

\* ---------------- the daemon stops, and the next one recovers ----------------
\* Whatever the daemon held in memory goes: the act, the lock (its pid is dead), the files
\* list of an import whose mark never came.
Stop == /\ Up /\ daemon' = "down"
        /\ cpc' = (IF cpc \in Active THEN "dead" ELSE cpc)
        /\ rpc' = (IF rpc \in RActive THEN "idle" ELSE rpc)
        /\ lock' = "free" /\ markOld' = (mark /= "none")
        /\ UNCHANGED <<run, Rec, mark, tgt>>
Start == daemon = "down" /\ daemon' = "up"
         /\ UNCHANGED <<run, Rec, mark, markOld, tgt, lock, cpc, rpc>>

\* recoverCrossings at a parent's service start, under the child lock (recover-crossing.ts:65).
RBegin == /\ Up /\ rpc = "idle" /\ lock = "free" /\ mark /= "none" /\ markOld
          /\ lock' = "recover" /\ rpc' = "readDst"
          /\ UNCHANGED <<run, Rec, mark, markOld, tgt, cpc, daemon>>
\* 1. The destination holds the target session: finish (:96-119). The mark names the target
\* session only from "verified" on.
RReadDst == /\ Up /\ rpc = "readDst"
            /\ IF run["dst"] = "running" /\ mark \in {"verified", "stopped", "started"}
               THEN /\ tgt' = "kept" /\ host' = "dst" /\ paneSet' = TRUE /\ exited' = FALSE /\ departed' = TRUE
                    /\ mark' = "none" /\ lock' = "free" /\ rpc' = "idle"
               ELSE rpc' = "readSrc" /\ UNCHANGED <<tgt, host, paneSet, exited, departed, mark, lock>>
            /\ UNCHANGED <<run, failed, markOld, cpc, daemon>>
\* 2. Undo: discard the files the mark lists, point the record at the source (:122-151).
RReadSrc == /\ Up /\ rpc = "readSrc"
            /\ tgt' = (IF tgt = "listed" THEN "none" ELSE tgt)
            /\ host' = "src" /\ paneSet' = TRUE
            /\ IF run["src"] = "running"
               THEN exited' = FALSE /\ mark' = "none" /\ lock' = "free" /\ rpc' = "idle"
               ELSE exited' = TRUE /\ rpc' = "resume" /\ UNCHANGED <<mark, lock>>
            /\ UNCHANGED <<run, failed, departed, markOld, cpc, daemon>>
\* 3. It ran nowhere: the mark goes first (:161), then resumeChild on the source.
RDropMark == /\ Up /\ rpc = "resume" /\ mark' = "none" /\ rpc' = "res2"
             /\ UNCHANGED <<run, Rec, markOld, tgt, lock, cpc, daemon>>
RResCheck == /\ Up /\ rpc = "res2"
             /\ IF run["src"] /= "none"
                THEN failed' = TRUE /\ lock' = "free" /\ rpc' = "idle" /\ UNCHANGED <<exited, paneSet>>
                ELSE exited' = FALSE /\ paneSet' = FALSE /\ rpc' = "res3" /\ UNCHANGED <<failed, lock>>
             /\ UNCHANGED <<run, host, departed, mark, markOld, tgt, cpc, daemon>>
RLaunch == /\ Up /\ rpc = "res3" /\ run' = [run EXCEPT !["src"] = "starting"] /\ rpc' = "res4"
           /\ UNCHANGED <<Rec, mark, markOld, tgt, lock, cpc, daemon>>
RStarted == /\ Up /\ rpc = "res4" /\ run["src"] = "running" /\ paneSet' = TRUE /\ lock' = "free" /\ rpc' = "idle"
            /\ UNCHANGED <<run, host, exited, failed, departed, mark, markOld, tgt, cpc, daemon>>
RFail == /\ Up /\ rpc \in {"res3", "res4"} /\ run["src"] /= "running"
         /\ run' = [run EXCEPT !["src"] = "none"] /\ failed' = TRUE /\ lock' = "free" /\ rpc' = "idle"
         /\ UNCHANGED <<host, exited, paneSet, departed, mark, markOld, tgt, cpc, daemon>>

Recover == RBegin \/ RReadDst \/ RReadSrc \/ RDropMark \/ RResCheck \/ RLaunch \/ RStarted \/ RFail

\* ---------------- herdr, the watcher and other starters ----------------
\* herdr reports a harness whose launch line was typed, whatever the daemon is doing.
Detect(m) == run[m] = "starting" /\ run' = [run EXCEPT ![m] = "running"]
             /\ UNCHANGED <<Rec, mark, markOld, tgt, lock, cpc, rpc, daemon>>
\* The watcher marks exited a live record whose pane runs no session. It skips a crossing child
\* and a record with no pane (watcher.ts:362-370).
WatcherExit == /\ Up /\ mark = "none" /\ ~exited /\ paneSet /\ run[host] = "none"
               /\ exited' = TRUE
               /\ UNCHANGED <<run, host, paneSet, failed, departed, mark, markOld, tgt, lock, cpc, rpc, daemon>>
\* Someone else starts the session on the source, whose panes don't hold it then. The source
\* keeps its session file through the crossing. A start on the destination from the copy needs
\* a session id no record there names, which this model leaves out.
OtherResume(peer) ==
  /\ IF peer THEN PeerResumes /\ ~(CarrySessionLock /\ lock /= "free") ELSE HandResumes
  /\ run["src"] = "none"
  /\ run' = [run EXCEPT !["src"] = "running"]
  /\ UNCHANGED <<Rec, mark, markOld, tgt, lock, cpc, rpc, daemon>>

Next == Carry \/ Recover \/ Stop \/ Start \/ WatcherExit
        \/ \E m \in M : Detect(m)
        \/ \E b \in BOOLEAN : OtherResume(b)
Spec == Init /\ [][Next]_vars

\* ---- Invariants ----
\* 2a across machines. A session runs in at most one place, counting a harness herdr has not
\* yet reported.
SessionOnePlace == Cardinality({m \in M : run[m] /= "none"}) <= 1
\* 4 for a crossing. No act holds the child, and its record names no pane, no exit, no mark and
\* no crossingFailed: nothing would repair it, and nothing tells a person where the session is.
RecordNeverStranded == ~(lock = "free" /\ mark = "none" /\ ~exited /\ ~failed /\ ~paneSet)
\* Every file a crossing wrote on the destination is either kept or named in a mark, so a
\* rollback or a recovery can remove it.
CopyAccounted == tgt = "unlisted" => cpc = "imported"
\* A finished crossing records the place it left, which retirement walks (#261).
LeftPlaceRecorded == (host = "dst" /\ mark = "none" /\ ~failed) => departed
====
