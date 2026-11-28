---- MODULE Claims ----
\* Bellwether pane claims, adoption, the watcher and resume. Written at origin/main
\* 2645cf4, and brought up to the fixes of issue #211 for items 6, 7 and 8 (#222,
\* #230, #236, #237). Each step that changed names the pull request.
\* Invariants 1, 2, 6 (first half) and 8 of the fleet brief.
\* One machine (the "pane machine") holds the panes. LocalParents run on it and
\* share its registry. Each FarParent runs on a machine of its own, so its
\* registry is visible only to itself; its claim on a pane lives in the pane
\* machine's relay records.
EXTENDS Naturals, FiniteSets

CONSTANTS FarParents, LocalParents, Panes, Sessions, MaxIds, NoSession,
  HandResumes,  \* TRUE: a person may start a session by hand while a resume of it is pending
  CleanupFails, \* TRUE: relay-cleanup at a far child's exit may fail, so its relay record outlives it
  AnswersLost   \* TRUE: a relay-adopt answer may time out after the far daemon saved the claim

Parents == FarParents \cup LocalParents
Keys3 == Parents \X Panes \X Sessions
Keys2 == Parents \X Sessions

VARIABLES
  paneSession,   \* herdr's truth: the harness session in each pane, or NoSession
  children,      \* every parent's registry rows: [id, parent, pane, session, live, replaced, adopted, doubt]
  relay,         \* who holds a pane for a far parent on the pane machine: [id, parent, pane,
                 \* session, adopted]. adopted: a claim in the relay records (pane-claims.ts:58).
                 \* Otherwise a far parent's started child whose adapter is connected to the daemon
                 \* there from that pane (#244). The connection keeps no session, which NoSession
                 \* stands for, and it closes when the harness process ends.
  pending,       \* resumes that passed holdsSession but have not started: [parent, session, key]
  nextId,        \* newChildId(), outbox.ts:18, made finite
  firstByPane,   \* ghost: first id a parent gave a (pane, session)
  firstBySess,   \* ghost: first id a parent gave a session
  sessOfId       \* ghost: first session an id stood for

vars == <<paneSession, children, relay, pending, nextId, firstByPane, firstBySess, sessOfId>>

\* `adopted`: the child stands for its session, since no child id rides in it (#222).
\* `doubt`: a far adoption whose answer the relay lost (#237).
Rec(p, x, s, i) == [id |-> i, parent |-> p, pane |-> x, session |-> s, live |-> TRUE, replaced |-> FALSE, adopted |-> TRUE, doubt |-> FALSE]

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

\* claimantOf (pane-claims.ts:26) and decideClaim (pane-claims.ts:41). An adopted claim for
\* a session the pane no longer runs is stale, even to its own parent (#244). A started
\* child carries its id in its adapter, so its record is never stale by session.
Stale(r, s) == r.adopted /\ r.session /= s
Decide(p, x, s) ==
  IF LocalHolder(x) /= {} THEN
     IF \E c \in LocalHolder(x) : c.parent = p THEN "held" ELSE "refuse"
  ELSE IF Claim(x) = {} THEN "take"
  ELSE IF \A r \in Claim(x) : Stale(r, s) THEN "take"
  ELSE IF \E r \in Claim(x) : ~Stale(r, s) /\ r.parent = p THEN "held"
  ELSE "refuse"

\* resumableAdoption: same parent and session, not replaced, exited or recorded live in
\* another pane, which herdr has just contradicted (#230). The pane need not match.
Earlier(p, x, s) == {c \in children : c.parent = p /\ c.adopted /\ ~c.replaced /\ c.session = s /\ (~c.live \/ c.pane /= x)}

\* adoptPane on the pane machine. No await between the guards and the write, so this is
\* one step. A stale far claim it takes over goes (#222).
LocalAdopt(p, x) ==
  LET s == paneSession[x]
      e == CHOOSE c \in Earlier(p, x, s) : TRUE
  IN
  /\ p \in LocalParents
  /\ s /= NoSession
  /\ OwnerSeen(p, x) = {}
  /\ Decide(p, x, s) /= "refuse"
  /\ IF Earlier(p, x, s) /= {}
     THEN /\ children' = (children \ {e}) \cup {[e EXCEPT !.live = TRUE, !.pane = x]}
          /\ nextId' = nextId
          /\ Note(p, x, s, e.id)
     ELSE /\ nextId <= MaxIds
          /\ children' = children \cup {Rec(p, x, s, nextId)}
          /\ nextId' = nextId + 1
          /\ Note(p, x, s, nextId)
  /\ relay' = IF Decide(p, x, s) = "take" THEN relay \ Claim(x) ELSE relay
  /\ UNCHANGED <<paneSession, pending>>

\* adoptPane for a pane on another machine, adopt.ts:131-194, with claimPane on the
\* far daemon (pane-claims.ts:58). replyLost: the relay-adopt answer times out after
\* the far daemon saved the claim (relay-links.ts:245-258), so the near registry
\* gets no row.
FarAdopt(p, x, replyLost) ==
  LET s == paneSession[x]
      dec == Decide(p, x, s)
      e == CHOOSE c \in Earlier(p, x, s) : TRUE
      proposed == IF Earlier(p, x, s) /= {} THEN e.id ELSE nextId
      answer == IF dec = "held" THEN (CHOOSE r \in Claim(x) : ~Stale(r, s) /\ r.parent = p).id ELSE proposed
  IN
  /\ p \in FarParents
  /\ s /= NoSession
  /\ OwnerSeen(p, x) = {}
  /\ dec /= "refuse"
  /\ proposed <= MaxIds
  \* saveRelayRecord keys a claim by child id, so the id's claim on another pane goes too.
  /\ relay' = IF dec = "take" THEN {r \in relay \ Claim(x) : r.id /= proposed} \cup {[id |-> proposed, parent |-> p, pane |-> x, session |-> s, adopted |-> TRUE]}
                              ELSE relay
  /\ nextId' = IF Earlier(p, x, s) = {} THEN nextId + 1 ELSE nextId
  \* A lost answer keeps the id it proposed, and the record holds the doubt (#237).
  /\ LET got == IF replyLost THEN proposed ELSE answer IN
     /\ children' =
          IF Earlier(p, x, s) /= {} /\ e.id = got
          THEN (children \ {e}) \cup {[e EXCEPT !.live = TRUE, !.pane = x, !.doubt = replyLost]}
          ELSE (IF Earlier(p, x, s) /= {}
                THEN (children \ {e}) \cup {[e EXCEPT !.replaced = TRUE]}
                ELSE children)
               \cup {[Rec(p, x, s, got) EXCEPT !.doubt = replyLost]}
     /\ Note(p, x, s, got)
  /\ UNCHANGED <<paneSession, pending>>

\* herdr: the harness in a pane quits, /clear or /resume starts another session in
\* it, or herdr reuses a closed pane id for a new agent.
SessionChange(x, s) ==
  /\ s /= paneSession[x]
  /\ s = NoSession \/ \A y \in Panes \ {x} : paneSession[y] /= s
  /\ HandResumes \/ s = NoSession \/ ~\E r \in pending : r.session = s
  /\ paneSession' = [paneSession EXCEPT ![x] = s]
  \* A harness that ends closes its adapter's connection (childLeft, #244). A session that
  \* changes in place, as /clear does, keeps the process and the connection.
  /\ relay' = IF s = NoSession THEN {r \in relay : r.adopted \/ r.pane /= x} ELSE relay
  /\ UNCHANGED <<children, pending, nextId, firstByPane, firstBySess, sessOfId>>

\* reconcile: a child that carries its id in its own adapter, one Bellwether started,
\* takes the pane's new session under its old id.
WatcherLearn(c) ==
  /\ c \in children
  /\ c.live /\ ~c.adopted /\ ~c.doubt
  /\ paneSession[c.pane] \notin {NoSession, c.session}
  /\ children' = (children \ {c}) \cup {[c EXCEPT !.session = paneSession[c.pane]]}
  /\ UNCHANGED <<paneSession, relay, pending, nextId, firstByPane, firstBySess, sessOfId>>

\* markExited runs cleanupRemote for a far child (watcher.ts:585). With CleanupFails the
\* call may fail, and CleanupRemote stands for a later success; otherwise it succeeds in
\* the exit's step.
Cleaned(c) == IF ~CleanupFails /\ c.parent \in FarParents
              THEN {r \in relay : ~(r.adopted /\ r.parent = c.parent /\ r.id = c.id)}
              ELSE relay

\* reconcile: an adopted child whose pane runs another session exits, keeping its own (#222).
WatcherLeave(c) ==
  /\ c \in children
  /\ c.live /\ c.adopted /\ ~c.doubt
  /\ paneSession[c.pane] \notin {NoSession, c.session}
  /\ children' = (children \ {c}) \cup {[c EXCEPT !.live = FALSE]}
  /\ relay' = Cleaned(c)
  /\ UNCHANGED <<paneSession, pending, nextId, firstByPane, firstBySess, sessOfId>>

\* settleAdoption: the watcher sends the claim again for an adoption in doubt (#237).
\* A kept or newly taken claim clears the doubt; a refusal, or the pane held for this
\* parent under another id, ends the child.
Settle(c) ==
  LET dec == Decide(c.parent, c.pane, c.session)
      mine == \E r \in Claim(c.pane) : r.parent = c.parent /\ r.id = c.id
  IN
  /\ c \in children
  /\ c.live /\ c.doubt
  /\ c.parent \in FarParents
  /\ IF dec = "take" \/ (dec = "held" /\ mine)
     THEN /\ children' = (children \ {c}) \cup {[c EXCEPT !.doubt = FALSE]}
          /\ relay' = IF dec = "take" THEN {r \in relay \ Claim(c.pane) : r.id /= c.id} \cup {[id |-> c.id, parent |-> c.parent, pane |-> c.pane, session |-> c.session, adopted |-> TRUE]}
                                      ELSE relay
     ELSE /\ children' = (children \ {c}) \cup {[c EXCEPT !.doubt = FALSE, !.live = FALSE, !.replaced = (dec = "held")]}
          /\ relay' = Cleaned(c)
  /\ UNCHANGED <<paneSession, pending, nextId, firstByPane, firstBySess, sessOfId>>

\* markExited, watcher.ts. Taking the step late stands for a daemon that was down.
WatcherExit(c) ==
  /\ c \in children
  /\ c.live
  /\ paneSession[c.pane] = NoSession
  /\ children' = (children \ {c}) \cup {[c EXCEPT !.live = FALSE]}
  /\ relay' = Cleaned(c)
  /\ UNCHANGED <<paneSession, pending, nextId, firstByPane, firstBySess, sessOfId>>

\* cleanupRemote after a far child exits, watcher.ts:585, when CleanupFails let the call
\* in the exit's step fail. It fails silently when the relay is down, which the model
\* expresses by never taking this step.
CleanupRemote(r) ==
  /\ r \in relay
  /\ r.adopted
  /\ ~\E c \in children : c.parent = r.parent /\ c.id = r.id /\ c.live
  /\ relay' = relay \ {r}
  /\ UNCHANGED <<paneSession, children, pending, nextId, firstByPane, firstBySess, sessOfId>>

\* comeBack: the same session runs in the exited child's pane again. A far child
\* reclaims first; ClaimHeldElsewhere marks it replaced. A local child asks who holds the
\* pane, as adoptPane does, and stops waiting on a refusal (#244). The code waits only
\* after the harness ended in its pane, not after a session change (#222), so this step
\* allows more than the code does: a breach it finds may not be real, but a hold is.
ComeBack(c) ==
  LET dec == Decide(c.parent, c.pane, c.session) IN
  /\ c \in children
  /\ ~c.live /\ ~c.replaced /\ c.adopted
  /\ paneSession[c.pane] = c.session
  /\ OwnerSeen(c.parent, c.pane) = {}
  /\ IF dec /= "refuse"
     THEN /\ children' = (children \ {c}) \cup {[c EXCEPT !.live = TRUE]}
          /\ relay' = IF dec /= "take" THEN relay
                      ELSE IF c.parent \in FarParents
                      THEN {r \in relay \ Claim(c.pane) : r.id /= c.id} \cup {[id |-> c.id, parent |-> c.parent, pane |-> c.pane, session |-> c.session, adopted |-> TRUE]}
                      ELSE relay \ Claim(c.pane)
     ELSE /\ children' = (children \ {c}) \cup {[c EXCEPT !.replaced = TRUE]}
          /\ relay' = relay
  /\ UNCHANGED <<paneSession, pending, nextId, firstByPane, firstBySess, sessOfId>>

\* spawnResume and resumeChild: check that no pane holds the session under a lock.
\* Every resume takes the session's lock, whether the parent knows the session as its
\* child or names it by id (#236).
LockKey(p, s) == <<"session", 0, s>>

ResumeCheck(p, s) ==
  /\ s \in {c.session : c \in children}
  /\ ~\E c \in children : c.parent = p /\ c.session = s /\ c.live
  /\ \A y \in Panes : paneSession[y] /= s                    \* holdsSession, resume.ts:146
  /\ ~\E r \in pending : r.key = LockKey(p, s)               \* child-lock.ts:65
  /\ pending' = pending \cup {[parent |-> p, session |-> s, key |-> LockKey(p, s)]}
  /\ UNCHANGED <<paneSession, children, relay, nextId, firstByPane, firstBySess, sessOfId>>

\* openChildTab and startHarness, resume.ts:257-286, after the awaits. No second check.
\* For a far parent, the child's adapter connects to the pane machine's daemon from pane y,
\* and childSaidHello records it (#244). The model takes the hello in the same step: the
\* code's start waits for that session before it reports the start.
ResumeStart(r, y) ==
  LET known == {c \in children : c.parent = r.parent /\ c.session = r.session /\ ~c.replaced}
      k == CHOOSE c \in known : TRUE
      id == IF known /= {} THEN k.id ELSE nextId
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
          /\ children' = children \cup {[Rec(r.parent, y, r.session, nextId) EXCEPT !.adopted = FALSE]}
          /\ nextId' = nextId + 1
          /\ Note(r.parent, y, r.session, nextId)
  /\ pending' = pending \ {r}
  /\ relay' = IF r.parent \in LocalParents \/ \E q \in relay : q.id = id /\ q.adopted
              THEN relay
              ELSE relay \cup {[id |-> id, parent |-> r.parent, pane |-> y, session |-> NoSession, adopted |-> FALSE]}

Next ==
  \/ \E p \in Parents, x \in Panes : LocalAdopt(p, x)
  \/ \E p \in Parents, x \in Panes, b \in (IF AnswersLost THEN BOOLEAN ELSE {FALSE}) : FarAdopt(p, x, b)
  \/ \E x \in Panes, s \in Sessions \cup {NoSession} : SessionChange(x, s)
  \/ \E c \in children : WatcherLearn(c) \/ WatcherLeave(c) \/ WatcherExit(c) \/ ComeBack(c) \/ Settle(c)
  \/ \E r \in relay : CleanupRemote(r)
  \/ \E p \in Parents, s \in Sessions : ResumeCheck(p, s)
  \/ \E r \in pending, y \in Panes : ResumeStart(r, y)

Spec == Init /\ [][Next]_vars

\* ---- Invariants ----

LiveOn(x) == {c \in children : c.live /\ c.pane = x}

\* 1a. No pane is watched by two parents.
NoPaneTwoParents == \A x \in Panes : Cardinality({c.parent : c \in LiveOn(x)}) <= 1

\* 1a, as the code can keep it. herdr changes a pane's session in one step, and a parent
\* on another machine learns of it in a later one, so for that step its record names a
\* session the pane no longer runs. A child whose record names another session, or that
\* is in doubt, does not count: no report from the pane reaches it, and its watcher
\* ends it on its next step (WatcherLeave).
Current(x) == {c \in LiveOn(x) : c.session = paneSession[x] /\ ~c.doubt}
NoPaneTwoParentsCurrent == \A x \in Panes : Cardinality({c.parent : c \in Current(x)}) <= 1

\* 1b. An adopted child's id never changes while its session and pane stay the same.
IdStableInPane == \A c \in children : (c.live /\ c.adopted) => firstByPane[<<c.parent, c.pane, c.session>>] \in {0, c.id}

\* 2a. A session runs in at most one pane.
SessionOnePane == \A s \in Sessions : Cardinality({x \in Panes : paneSession[x] = s}) <= 1

\* 2b. A pane has at most one live child.
PaneOneLiveChild == \A x \in Panes : Cardinality(LiveOn(x)) <= 1

\* 2b, as the code can keep it, by the reasoning of NoPaneTwoParentsCurrent.
PaneOneLiveChildCurrent == \A x \in Panes : Cardinality(Current(x)) <= 1

\* 6a. A far claim names the pane that holds its session. A claim is an adopted record:
\* a started child's record keeps no session (#244).
FarClaimCurrent == \A r \in relay : r.adopted => paneSession[r.pane] = r.session

\* 8a. A session answers to one parent: adoptedParentOf (adopted-session.ts:63) finds
\* exactly one candidate, so readdir order never decides.
Candidates(x) ==
  {c.parent : c \in {c \in LiveOn(x) : c.parent \in LocalParents /\ c.session = paneSession[x]}}
  \cup {r.parent : r \in {r \in Claim(x) : r.adopted /\ r.session = paneSession[x]}}
RouteUnambiguous == \A x \in Panes : Cardinality(Candidates(x)) <= 1

\* 8b. The routed far parent still watches the pane (otherwise reports go to a parent
\* whose child is gone or never recorded).
RouteToWatcher == \A x \in Panes : \A r \in Claim(x) :
  r.adopted /\ r.session = paneSession[x] => \E c \in children : c.parent = r.parent /\ c.id = r.id /\ c.live

\* 8c. A re-adoption keeps the id a parent first gave the session.
IdStableBySession == \A c \in children : (c.live /\ c.adopted) => firstBySess[<<c.parent, c.session>>] \in {0, c.id}

\* Extra (inv 1 in spirit): an adopted child's id stands for one session. A child
\* Bellwether started carries its id in its own adapter, so a /clear keeps it.
OneSessionPerId == \A c \in children : (c.live /\ c.adopted) => sessOfId[c.id] \in {NoSession, c.session}
====
