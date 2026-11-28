---- MODULE Claims ----
\* Bellwether pane claims, adoption, the watcher and resume, at origin/main 2645cf4.
\* Invariants 1, 2, 6 (first half) and 8 of the fleet brief.
\* One machine (the "pane machine") holds the panes. LocalParents run on it and
\* share its registry. Each FarParent runs on a machine of its own, so its
\* registry is visible only to itself; its claim on a pane lives in the pane
\* machine's relay records.
EXTENDS Naturals, FiniteSets

CONSTANTS FarParents, LocalParents, Panes, Sessions, MaxIds, NoSession

Parents == FarParents \cup LocalParents
Keys3 == Parents \X Panes \X Sessions
Keys2 == Parents \X Sessions

VARIABLES
  paneSession,   \* herdr's truth: the harness session in each pane, or NoSession
  children,      \* every parent's registry rows: [id, parent, pane, session, live, replaced]
  relay,         \* the pane machine's adopted relay records: [id, parent, pane, session]
  pending,       \* resumes that passed holdsSession but have not started: [parent, session, key]
  nextId,        \* newChildId(), outbox.ts:18, made finite
  firstByPane,   \* ghost: first id a parent gave a (pane, session)
  firstBySess,   \* ghost: first id a parent gave a session
  sessOfId       \* ghost: first session an id stood for

vars == <<paneSession, children, relay, pending, nextId, firstByPane, firstBySess, sessOfId>>

Rec(p, x, s, i) == [id |-> i, parent |-> p, pane |-> x, session |-> s, live |-> TRUE, replaced |-> FALSE]

Init ==
  /\ paneSession \in {f \in [Panes -> Sessions \cup {NoSession}] :
        \A a, b \in Panes : (a /= b /\ f[a] /= NoSession) => f[a] /= f[b]}
  /\ children = {}
  /\ relay = {}
  /\ pending = {}
  /\ nextId = 1
  /\ firstByPane = [k \in Keys3 |-> 0]
  /\ firstBySess = [k \in Keys2 |-> 0]
  /\ sessOfId = [i \in 1..MaxIds |-> NoSession]

\* The ghosts record the first id given; they never steer the system.
Note(p, x, s, i) ==
  /\ firstByPane' = IF firstByPane[<<p, x, s>>] = 0 THEN [firstByPane EXCEPT ![<<p, x, s>>] = i] ELSE firstByPane
  /\ firstBySess' = IF firstBySess[<<p, s>>] = 0 THEN [firstBySess EXCEPT ![<<p, s>>] = i] ELSE firstBySess
  /\ sessOfId' = IF sessOfId[i] = NoSession THEN [sessOfId EXCEPT ![i] = s] ELSE sessOfId

\* watcherOfPane (registry.ts:179) reads only the registry of the machine it runs on.
Seen(p) == IF p \in LocalParents THEN {c \in children : c.parent \in LocalParents}
                                 ELSE {c \in children : c.parent = p}
OwnerSeen(p, x) == {c \in Seen(p) : c.live /\ c.pane = x}
LocalHolder(x) == {c \in children : c.parent \in LocalParents /\ c.live /\ c.pane = x}
Claim(x) == {r \in relay : r.pane = x}

\* claimantOf (pane-claims.ts:26) and decideClaim (pane-claims.ts:41).
Decide(p, x, s) ==
  IF LocalHolder(x) /= {} THEN
     IF \E c \in LocalHolder(x) : c.parent = p THEN "held" ELSE "refuse"
  ELSE IF Claim(x) = {} THEN "take"
  ELSE IF \E r \in Claim(x) : r.parent = p THEN "held"
  ELSE IF \A r \in Claim(x) : r.session /= s THEN "take"
  ELSE "refuse"

\* resumableAdoption, adopt.ts:63: same parent, pane and session, exited, not replaced.
Earlier(p, x, s) == {c \in children : c.parent = p /\ ~c.live /\ ~c.replaced /\ c.pane = x /\ c.session = s}

\* adoptPane on the pane machine, adopt.ts:100-194. No await between the guards and
\* the write, so this is one step. A stale far claim is passed over, not removed.
LocalAdopt(p, x) ==
  LET s == paneSession[x]
      e == CHOOSE c \in Earlier(p, x, s) : TRUE
  IN
  /\ p \in LocalParents
  /\ s /= NoSession
  /\ OwnerSeen(p, x) = {}
  /\ Decide(p, x, s) /= "refuse"
  /\ IF Earlier(p, x, s) /= {}
     THEN /\ children' = (children \ {e}) \cup {[e EXCEPT !.live = TRUE]}
          /\ nextId' = nextId
          /\ Note(p, x, s, e.id)
     ELSE /\ nextId <= MaxIds
          /\ children' = children \cup {Rec(p, x, s, nextId)}
          /\ nextId' = nextId + 1
          /\ Note(p, x, s, nextId)
  /\ UNCHANGED <<paneSession, relay, pending>>

\* adoptPane for a pane on another machine, adopt.ts:131-194, with claimPane on the
\* far daemon (pane-claims.ts:58). replyLost: the relay-adopt answer times out after
\* the far daemon saved the claim (relay-links.ts:245-258), so the near registry
\* gets no row.
FarAdopt(p, x, replyLost) ==
  LET s == paneSession[x]
      dec == Decide(p, x, s)
      e == CHOOSE c \in Earlier(p, x, s) : TRUE
      proposed == IF Earlier(p, x, s) /= {} THEN e.id ELSE nextId
      answer == IF dec = "held" THEN (CHOOSE r \in Claim(x) : r.parent = p).id ELSE proposed
  IN
  /\ p \in FarParents
  /\ s /= NoSession
  /\ OwnerSeen(p, x) = {}
  /\ dec /= "refuse"
  /\ proposed <= MaxIds
  /\ relay' = IF dec = "take" THEN (relay \ Claim(x)) \cup {[id |-> proposed, parent |-> p, pane |-> x, session |-> s]}
                              ELSE relay
  /\ nextId' = IF Earlier(p, x, s) = {} THEN nextId + 1 ELSE nextId
  /\ IF replyLost
     THEN /\ children' = children
          /\ UNCHANGED <<firstByPane, firstBySess, sessOfId>>
     ELSE /\ children' =
               IF Earlier(p, x, s) /= {} /\ e.id = answer
               THEN (children \ {e}) \cup {[e EXCEPT !.live = TRUE]}
               ELSE (IF Earlier(p, x, s) /= {}
                     THEN (children \ {e}) \cup {[e EXCEPT !.replaced = TRUE]}   \* adopt.ts:156-161
                     ELSE children)
                    \cup {Rec(p, x, s, answer)}
          /\ Note(p, x, s, answer)
  /\ UNCHANGED <<paneSession, pending>>

\* herdr: the harness in a pane quits, /clear or /resume starts another session in
\* it, or herdr reuses a closed pane id for a new agent.
SessionChange(x, s) ==
  /\ s /= paneSession[x]
  /\ s = NoSession \/ \A y \in Panes \ {x} : paneSession[y] /= s
  /\ paneSession' = [paneSession EXCEPT ![x] = s]
  /\ UNCHANGED <<children, relay, pending, nextId, firstByPane, firstBySess, sessOfId>>

\* learnAgent (watcher.ts:750) and reconcile (watcher.ts:792, :814): the live child
\* takes the pane's new session under its old id. The relay record keeps the old one
\* (its session is written only at pane-claims.ts:76).
WatcherLearn(c) ==
  /\ c \in children
  /\ c.live
  /\ paneSession[c.pane] \notin {NoSession, c.session}
  /\ children' = (children \ {c}) \cup {[c EXCEPT !.session = paneSession[c.pane]]}
  /\ UNCHANGED <<paneSession, relay, pending, nextId, firstByPane, firstBySess, sessOfId>>

\* markExited, watcher.ts:542-562. Taking the step late stands for a daemon that was down.
WatcherExit(c) ==
  /\ c \in children
  /\ c.live
  /\ paneSession[c.pane] = NoSession
  /\ children' = (children \ {c}) \cup {[c EXCEPT !.live = FALSE]}
  /\ UNCHANGED <<paneSession, relay, pending, nextId, firstByPane, firstBySess, sessOfId>>

\* cleanupRemote after a far child exits, watcher.ts:574. It fails silently when the
\* relay is down, which the model expresses by never taking this step.
CleanupRemote(r) ==
  /\ r \in relay
  /\ ~\E c \in children : c.parent = r.parent /\ c.id = r.id /\ c.live
  /\ relay' = relay \ {r}
  /\ UNCHANGED <<paneSession, children, pending, nextId, firstByPane, firstBySess, sessOfId>>

\* comeBack, watcher.ts:500-527: the same session runs in the exited child's pane again.
\* A far child reclaims first; ClaimHeldElsewhere marks it replaced (watcher.ts:516).
ComeBack(c) ==
  LET dec == Decide(c.parent, c.pane, c.session) IN
  /\ c \in children
  /\ ~c.live /\ ~c.replaced
  /\ paneSession[c.pane] = c.session
  /\ OwnerSeen(c.parent, c.pane) = {}
  /\ IF c.parent \in LocalParents \/ dec /= "refuse"
     THEN /\ children' = (children \ {c}) \cup {[c EXCEPT !.live = TRUE]}
          /\ relay' = IF c.parent \in FarParents /\ dec = "take"
                      THEN (relay \ Claim(c.pane)) \cup {[id |-> c.id, parent |-> c.parent, pane |-> c.pane, session |-> c.session]}
                      ELSE relay
     ELSE /\ children' = (children \ {c}) \cup {[c EXCEPT !.replaced = TRUE]}
          /\ relay' = relay
  /\ UNCHANGED <<paneSession, pending, nextId, firstByPane, firstBySess, sessOfId>>

\* spawn-resume.ts:79-88 and resume.ts:135-147: under the child lock, check that no
\* pane holds the session. The lock key is the child id when the parent knows the
\* session, else "session-<basename>" (spawn-resume.ts:85).
LockKey(p, s) ==
  IF \E c \in children : c.parent = p /\ c.session = s /\ ~c.replaced
  THEN <<"child", (CHOOSE c \in children : c.parent = p /\ c.session = s /\ ~c.replaced).id, NoSession>>
  ELSE <<"session", 0, s>>

ResumeCheck(p, s) ==
  /\ s \in {c.session : c \in children}
  /\ ~\E c \in children : c.parent = p /\ c.session = s /\ c.live
  /\ \A y \in Panes : paneSession[y] /= s                    \* holdsSession, resume.ts:146
  /\ ~\E r \in pending : r.key = LockKey(p, s)               \* child-lock.ts:65
  /\ pending' = pending \cup {[parent |-> p, session |-> s, key |-> LockKey(p, s)]}
  /\ UNCHANGED <<paneSession, children, relay, nextId, firstByPane, firstBySess, sessOfId>>

\* openChildTab and startHarness, resume.ts:257-286, after the awaits. No second check.
ResumeStart(r, y) ==
  LET known == {c \in children : c.parent = r.parent /\ c.session = r.session /\ ~c.replaced}
      k == CHOOSE c \in known : TRUE
  IN
  /\ r \in pending
  /\ paneSession[y] = NoSession
  /\ ~\E c \in children : c.live /\ c.pane = y
  /\ paneSession' = [paneSession EXCEPT ![y] = r.session]
  /\ IF known /= {}
     THEN /\ children' = (children \ {k}) \cup {[k EXCEPT !.live = TRUE, !.pane = y]}
          /\ nextId' = nextId
          /\ Note(r.parent, y, r.session, k.id)
     ELSE /\ nextId <= MaxIds
          /\ children' = children \cup {Rec(r.parent, y, r.session, nextId)}
          /\ nextId' = nextId + 1
          /\ Note(r.parent, y, r.session, nextId)
  /\ pending' = pending \ {r}
  /\ UNCHANGED relay

Next ==
  \/ \E p \in Parents, x \in Panes : LocalAdopt(p, x)
  \/ \E p \in Parents, x \in Panes, b \in BOOLEAN : FarAdopt(p, x, b)
  \/ \E x \in Panes, s \in Sessions \cup {NoSession} : SessionChange(x, s)
  \/ \E c \in children : WatcherLearn(c) \/ WatcherExit(c) \/ ComeBack(c)
  \/ \E r \in relay : CleanupRemote(r)
  \/ \E p \in Parents, s \in Sessions : ResumeCheck(p, s)
  \/ \E r \in pending, y \in Panes : ResumeStart(r, y)

Spec == Init /\ [][Next]_vars

\* ---- Invariants ----

LiveOn(x) == {c \in children : c.live /\ c.pane = x}

\* 1a. No pane is watched by two parents.
NoPaneTwoParents == \A x \in Panes : Cardinality({c.parent : c \in LiveOn(x)}) <= 1

\* 1b. An adopted child's id never changes while its session and pane stay the same.
IdStableInPane == \A c \in children : c.live => firstByPane[<<c.parent, c.pane, c.session>>] \in {0, c.id}

\* 2a. A session runs in at most one pane.
SessionOnePane == \A s \in Sessions : Cardinality({x \in Panes : paneSession[x] = s}) <= 1

\* 2b. A pane has at most one live child.
PaneOneLiveChild == \A x \in Panes : Cardinality(LiveOn(x)) <= 1

\* 6a. A far claim names the pane that holds its session.
FarClaimCurrent == \A r \in relay : paneSession[r.pane] = r.session

\* 8a. A session answers to one parent: adoptedParentOf (adopted-session.ts:63) finds
\* exactly one candidate, so readdir order never decides.
Candidates(x) ==
  {c.parent : c \in {c \in LiveOn(x) : c.parent \in LocalParents /\ c.session = paneSession[x]}}
  \cup {r.parent : r \in {r \in Claim(x) : r.session = paneSession[x]}}
RouteUnambiguous == \A x \in Panes : Cardinality(Candidates(x)) <= 1

\* 8b. The routed far parent still watches the pane (otherwise reports go to a parent
\* whose child is gone or never recorded).
RouteToWatcher == \A x \in Panes : \A r \in Claim(x) :
  r.session = paneSession[x] => \E c \in children : c.parent = r.parent /\ c.id = r.id /\ c.live

\* 8c. A re-adoption keeps the id a parent first gave the session.
IdStableBySession == \A c \in children : c.live => firstBySess[<<c.parent, c.session>>] \in {0, c.id}

\* Extra (inv 1 in spirit): a child id stands for one session.
OneSessionPerId == \A c \in children : c.live => sessOfId[c.id] \in {NoSession, c.session}
====
