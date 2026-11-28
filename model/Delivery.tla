---- MODULE Delivery ----
\* One brief, sent by deliverBrief (brief-delivery.ts:75) through messageChild (send.ts:143)
\* and sessionInbox (server.ts:295), at 2645cf4. Invariants 5 and 6 (second half).
\* A far child takes the same shape: the relay ask timeout (relay-links.ts:219) stands in
\* for the 5 s ack timer, and a dropped link for a lost ack.
EXTENDS Naturals

CONSTANTS StrayWorking,  \* herdr can report "working" on the pane for a reason other than the brief
          MaxPushes      \* 2: deliverBrief resends once (brief-delivery.ts:177)

VARIABLES
  sending,     \* brief-delivery.ts:167: set before send()
  turnSeen,    \* turnAt: a "working" status while sending (brief-delivery.ts:108-111)
  readSeen,    \* inbox.read resolved: the adapter saw the message enter the model's context
  pushes,      \* copies written to the session socket
  inSession,   \* copies the adapter queued into the session
  ack,         \* "none", "wait", "delivered", "lapsed" for the newest copy
  typed,       \* copies typed into the pane (send.ts:194/199)
  modelTurn,   \* the model began a turn on the brief
  taken,       \* recordDelivery wrote takenAt (brief-delivery.ts:185-187)
  done

vars == <<sending, turnSeen, readSeen, pushes, inSession, ack, typed, modelTurn, taken, done>>

Init == sending = FALSE /\ turnSeen = FALSE /\ readSeen = FALSE /\ pushes = 0 /\ inSession = 0
        /\ ack = "none" /\ typed = 0 /\ modelTurn = FALSE /\ taken = FALSE /\ done = FALSE

\* sending = true, then send(): up to 30 s of awaitSession, then the push with a 5 s ack timer.
Push == ~done /\ pushes < MaxPushes /\ ack \in {"none", "delivered"} /\ (pushes = 0 \/ ~(turnSeen \/ readSeen))
        /\ sending' = TRUE /\ pushes' = pushes + 1 /\ ack' = "wait"
        /\ UNCHANGED <<turnSeen, readSeen, inSession, typed, modelTurn, taken, done>>
\* The adapter queues the copy into the session and acks "queued".
AdapterQueue == inSession < pushes /\ inSession' = inSession + 1
                /\ ack' = (IF ack = "wait" THEN "delivered" ELSE ack)  \* a late ack is only logged (server.ts:375)
                /\ UNCHANGED <<sending, turnSeen, readSeen, pushes, typed, modelTurn, taken, done>>
\* The ack timer fires first: forget, then type the same text (send.ts:175, :194).
AckTimeout == ack = "wait" /\ ack' = "lapsed" /\ typed' = typed + 1
              /\ UNCHANGED <<sending, turnSeen, readSeen, pushes, inSession, modelTurn, taken, done>>
\* herdr reports "working" for something else while sending is true.
Stray == StrayWorking /\ sending /\ ~turnSeen /\ turnSeen' = TRUE
         /\ UNCHANGED <<sending, readSeen, pushes, inSession, ack, typed, modelTurn, taken, done>>
\* The model takes the brief: from the session (a read receipt) or from the typed text.
ModelTakes == (inSession + typed) > 0 /\ ~modelTurn /\ modelTurn' = TRUE
              /\ turnSeen' = (turnSeen \/ sending) /\ readSeen' = (readSeen \/ inSession > 0)
              /\ UNCHANGED <<sending, pushes, inSession, ack, typed, taken, done>>
\* taken() returns at once on turnAt or a read (brief-delivery.ts:143); recordDelivery.
Record == ~done /\ ack = "delivered" /\ (turnSeen \/ readSeen) /\ taken' = TRUE /\ done' = TRUE /\ sending' = FALSE
          /\ UNCHANGED <<turnSeen, readSeen, pushes, inSession, ack, typed, modelTurn>>
\* A typed brief records no takenAt; the act ends.
TypedEnd == ~done /\ ack = "lapsed" /\ done' = TRUE /\ sending' = FALSE
            /\ UNCHANGED <<turnSeen, readSeen, pushes, inSession, ack, typed, modelTurn, taken>>

Next == Push \/ AdapterQueue \/ AckTimeout \/ Stray \/ ModelTakes \/ Record \/ TypedEnd
Spec == Init /\ [][Next]_vars

\* 5. A brief is recorded as taken only if the model began a turn on it.
TakenMeansTurn == taken => modelTurn
\* 6b. A message enters exactly one session, once.
EntersOnce == inSession + typed <= 1
====
