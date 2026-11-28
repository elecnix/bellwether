---- MODULE Delivery ----
\* One brief, sent by deliverBrief (brief-delivery.ts) through messageChild (send.ts) and
\* sessionInbox (server.ts). Written at 2645cf4 and brought up to f3fe3a7: #216 (taken needs
\* a read and a turn), #217 and #221 (a push is never typed as well), #248 (a copy whose read
\* came never goes again). Invariants 5 and 6 (second half).
\* A far child takes the same shape: relay-message carries the push, and relayInDoubt with
\* relay-message-again stands for a lost ack, answered from the far side's pushed list.
EXTENDS Naturals

CONSTANTS StrayWorking,     \* herdr can report "working" on the pane for a reason other than the brief
          MaxPushes,        \* 2: deliverBrief sends a second copy when the first has no read (BD:229-240)
          SessionMayFail,   \* the session refuses a copy or is gone, so herdr types it (S:215-232)
          AdapterRestarts   \* the adapter process restarts while a copy waits in the harness's queue,
                            \* so the hello replay offers it to a process that never saw it

Copies == 1..2

VARIABLES
  pushes,      \* copies sent
  via,         \* per copy: "none", "session" (pushed to the adapter) or "typed" (into the pane)
  ack,         \* per copy: "none", "wait", "queued", "unanswered" (5 s passed or the connection closed)
  queued,      \* per copy: times the copy sits in the harness's input (adapter queue or typed line)
  entered,     \* per copy: times the copy entered the model's conversation
  readSeen,    \* the daemon holds a read receipt for some copy (inbox.read)
  watch,       \* the newest copy's wait: "idle", "watching", "over" (20 s with no read and turn)
  turnAt,      \* herdr reported "working" since the newest copy's push began (BD:133-138)
  modelTurn,   \* the model began a turn on the brief
  undelivered1,\* copy 1 marked undelivered once copy 2's send resolved (markResent, BD:241)
  taken,       \* takenAt written (BD:255-258)
  done,        \* the delivery settled: taken, read only, or BriefNotTaken
  failed       \* BriefNotTaken: the spawn fails and closes the pane

vars == <<pushes, via, ack, queued, entered, readSeen, watch, turnAt, modelTurn, undelivered1, taken, done, failed>>

Init == /\ pushes = 0 /\ via = [k \in Copies |-> "none"] /\ ack = [k \in Copies |-> "none"]
        /\ queued = [k \in Copies |-> 0] /\ entered = [k \in Copies |-> 0]
        /\ readSeen = FALSE /\ watch = "idle" /\ turnAt = FALSE /\ modelTurn = FALSE
        /\ undelivered1 = FALSE /\ taken = FALSE /\ done = FALSE /\ failed = FALSE

\* send(): pushing on and turnAt cleared, then the push (or, with no session, herdr types it).
\* A second copy goes only when the first was answered, no read came, and its wait is over.
Push(typedIt) ==
  LET k == pushes + 1 IN
  /\ ~done /\ pushes < MaxPushes
  /\ k = 1 \/ (watch = "over" /\ ~readSeen /\ ack[1] /= "unanswered")
  /\ typedIt => SessionMayFail
  /\ pushes' = k
  /\ via' = [via EXCEPT ![k] = IF typedIt THEN "typed" ELSE "session"]
  /\ ack' = [ack EXCEPT ![k] = IF typedIt THEN "none" ELSE "wait"]
  /\ queued' = IF typedIt THEN [queued EXCEPT ![k] = 1] ELSE queued
  /\ watch' = "watching" /\ turnAt' = FALSE
  /\ undelivered1' = (undelivered1 \/ (k = 2 /\ typedIt))
  /\ UNCHANGED <<entered, readSeen, modelTurn, taken, done, failed>>

\* The adapter queues the copy into the harness and acks "queued". A late ack, after the copy
\* went unanswered, is only logged (lateAnswer, SV:483-510).
AdapterQueue(k) ==
  /\ via[k] = "session" /\ ack[k] \in {"wait", "unanswered"} /\ queued[k] = 0
  /\ queued' = [queued EXCEPT ![k] = 1]
  /\ ack' = [ack EXCEPT ![k] = IF ack[k] = "wait" THEN "queued" ELSE ack[k]]
  /\ undelivered1' = (undelivered1 \/ k = 2)
  /\ UNCHANGED <<pushes, via, entered, readSeen, watch, turnAt, modelTurn, taken, done, failed>>

\* The 5 s timer fires or the connection closes first. Nothing is typed (#217, #221): the copy
\* stays unread for the hello replay.
AckTimeout(k) ==
  /\ ack[k] = "wait"
  /\ ack' = [ack EXCEPT ![k] = "unanswered"]
  /\ undelivered1' = (undelivered1 \/ k = 2)
  /\ UNCHANGED <<pushes, via, queued, entered, readSeen, watch, turnAt, modelTurn, taken, done, failed>>

\* A new adapter process says hello. The replay offers every copy that went by the session and
\* has no read on the record, apart from copy 1 once markResent ran. The process looks for the
\* id in the transcript, so a copy still waiting in the harness's queue is pushed again.
Replay(k) ==
  /\ AdapterRestarts /\ ~failed
  /\ via[k] = "session" /\ ack[k] \in {"queued", "unanswered"} /\ ~readSeen
  /\ ~(k = 1 /\ undelivered1)
  /\ queued[k] = 1 /\ entered[k] = 0
  /\ queued' = [queued EXCEPT ![k] = 2]
  /\ UNCHANGED <<pushes, via, ack, entered, readSeen, watch, turnAt, modelTurn, undelivered1, taken, done, failed>>

\* The harness puts a waiting copy into the conversation. A closed pane takes nothing in.
Enter(k) ==
  /\ ~failed /\ entered[k] < queued[k]
  /\ entered' = [entered EXCEPT ![k] = entered[k] + 1]
  /\ UNCHANGED <<pushes, via, ack, queued, readSeen, watch, turnAt, modelTurn, undelivered1, taken, done, failed>>

\* The adapter's read receipt reaches the daemon (pi at message_end, Claude from the transcript).
\* A typed copy has no adapter to send one.
Read(k) ==
  /\ entered[k] > 0 /\ via[k] = "session" /\ ~readSeen
  /\ readSeen' = TRUE
  /\ UNCHANGED <<pushes, via, ack, queued, entered, watch, turnAt, modelTurn, undelivered1, taken, done, failed>>

\* herdr reports "working" for something else while a copy's wait runs.
Stray == StrayWorking /\ watch = "watching" /\ ~turnAt /\ turnAt' = TRUE
         /\ UNCHANGED <<pushes, via, ack, queued, entered, readSeen, watch, modelTurn, undelivered1, taken, done, failed>>

\* The model begins a turn on the brief; herdr reports it while the wait runs.
ModelTurn == (entered[1] + entered[2]) > 0 /\ ~modelTurn /\ ~failed
             /\ modelTurn' = TRUE /\ turnAt' = (turnAt \/ watch = "watching")
             /\ UNCHANGED <<pushes, via, ack, queued, entered, readSeen, watch, undelivered1, taken, done, failed>>

\* 20 s pass on the newest copy's wait.
Deadline == watch = "watching" /\ ~done /\ watch' = "over"
            /\ UNCHANGED <<pushes, via, ack, queued, entered, readSeen, turnAt, modelTurn, undelivered1, taken, done, failed>>

\* watch() returns on a read and a turn together: takenAt (BD:190-218, 255-258).
Record == ~done /\ readSeen /\ turnAt /\ taken' = TRUE /\ done' = TRUE /\ watch' = "idle"
          /\ UNCHANGED <<pushes, via, ack, queued, entered, readSeen, turnAt, modelTurn, undelivered1, failed>>
\* A read with no turn by the deadline writes readAt, no takenAt, and never resends (#246).
ReadOnly == ~done /\ readSeen /\ watch = "over" /\ ~turnAt /\ done' = TRUE /\ watch' = "idle"
            /\ UNCHANGED <<pushes, via, ack, queued, entered, readSeen, turnAt, modelTurn, undelivered1, taken, failed>>
\* A typed copy ends the act with no takenAt: there is no receipt to wait for.
TypedEnd == ~done /\ pushes > 0 /\ via[pushes] = "typed" /\ done' = TRUE /\ watch' = "idle"
            /\ UNCHANGED <<pushes, via, ack, queued, entered, readSeen, turnAt, modelTurn, undelivered1, taken, failed>>
\* No read once the last copy's wait is over, and no copy left to send: BriefNotTaken.
NotTaken == /\ ~done /\ ~readSeen /\ watch = "over" /\ via[pushes] = "session"
            /\ (pushes = MaxPushes \/ ack[1] = "unanswered")
            /\ failed' = TRUE /\ done' = TRUE /\ watch' = "idle"
            /\ UNCHANGED <<pushes, via, ack, queued, entered, readSeen, turnAt, modelTurn, undelivered1, taken>>

Next == \/ \E b \in BOOLEAN : Push(b)
        \/ \E k \in Copies : AdapterQueue(k) \/ AckTimeout(k) \/ Replay(k) \/ Enter(k) \/ Read(k)
        \/ Stray \/ ModelTurn \/ Deadline \/ Record \/ ReadOnly \/ TypedEnd \/ NotTaken
Spec == Init /\ [][Next]_vars

\* 5. A brief is recorded as taken only if the model began a turn on it.
TakenMeansTurn == taken => modelTurn
\* 6b. A brief enters the session once: its copies enter the conversation once in all.
EntersOnce == entered[1] + entered[2] <= 1
====
