---- MODULE Release ----
\* Release notes and the release script (scripts/release.ts, scripts/release-notes.ts).
\* Written at 2645cf4 and brought up to f3fe3a7: #223 added a second check after the
\* release pull request merges, over the pull requests its release commit carries, and
\* refused notes under a published version; #260 keeps such a note when that version's
\* release commit carries every pull request it names. Invariant 9.
\* A note is a file under release-notes/<version>/. No check runs when a pull request merges.
EXTENDS Naturals

CONSTANTS PRs, MaxV

VARIABLES
  opened,     \* PR -> BOOLEAN
  mergedAt,   \* PR -> position on main's first-parent history, 0 while open
  note,       \* PR -> version directory of its note, 0 for none
  label,      \* PR -> carries "release-note: none"
  cur,        \* the version the next release cuts (npm latest + 1)
  published,  \* versions npm serves
  relAt,      \* version -> position of its "release: V" commit, 0 if unreleased
  phase,      \* "idle", "checked" (check 1 passed, the release PR waits on CI), "merged"
              \* (the release commit is on main), "staged" (check 2 passed, npm stage publish)
  clock,
  shippedStale \* ghost: a release went out whose commit carries a note check 2 should refuse

vars == <<opened, mergedAt, note, label, cur, published, relAt, phase, clock, shippedStale>>

LastRel == IF cur = 1 THEN 0 ELSE relAt[cur - 1]

Init == opened = [p \in PRs |-> FALSE] /\ mergedAt = [p \in PRs |-> 0] /\ note = [p \in PRs |-> 0]
        /\ label = [p \in PRs |-> FALSE] /\ cur = 1 /\ published = {} /\ relAt = [v \in 1..MaxV |-> 0]
        /\ phase = "idle" /\ clock = 0 /\ shippedStale = FALSE

\* A PR opens with a note for the version that is next at that moment, or none, or a label.
Open(p, withNote, lab) ==
  /\ ~opened[p] /\ opened' = [opened EXCEPT ![p] = TRUE]
  /\ note' = [note EXCEPT ![p] = IF withNote THEN cur ELSE 0]
  /\ label' = [label EXCEPT ![p] = lab]
  /\ UNCHANGED <<mergedAt, cur, published, relAt, phase, clock, shippedStale>>

Merge(p) ==
  /\ opened[p] /\ mergedAt[p] = 0
  /\ clock' = clock + 1 /\ mergedAt' = [mergedAt EXCEPT ![p] = clock + 1]
  /\ UNCHANGED <<opened, note, label, cur, published, relAt, phase, shippedStale>>

\* refuseNotesUnderPublished (release.ts:640-679): a note under a published version stays only
\* when that version's release commit carries the pull request it names (#260).
Stale(p, upto) == mergedAt[p] /= 0 /\ mergedAt[p] <= upto /\ note[p] \in published /\ mergedAt[p] > relAt[note[p]]
NoStale(upto) == \A p \in PRs : ~Stale(p, upto)
\* Every pull request merged in (LastRel, upto] has a note under cur, or the label.
Recorded(upto) == \A p \in PRs : (mergedAt[p] > LastRel /\ mergedAt[p] <= upto) => (note[p] = cur \/ label[p])

\* Check 1, refuseUnrecorded in openReleasePr (release.ts:583-596), over main as it is now.
StartRelease ==
  /\ phase = "idle" /\ cur <= MaxV
  /\ NoStale(clock) /\ Recorded(clock)
  /\ phase' = "checked"
  /\ UNCHANGED <<opened, mergedAt, note, label, cur, published, relAt, clock, shippedStale>>

\* Someone files a missing note under cur in a note-only pull request: after check 1 stops,
\* or after check 2 stops, before a rerun.
FixNote(p) ==
  /\ phase \in {"idle", "merged"}
  /\ mergedAt[p] > LastRel /\ note[p] /= cur /\ ~label[p]
  /\ note' = [note EXCEPT ![p] = cur]
  /\ UNCHANGED <<opened, mergedAt, label, cur, published, relAt, phase, clock, shippedStale>>

\* mergeWhenGreen squash-merges the release PR onto main, after anything merged meanwhile.
MergeRelease ==
  /\ phase = "checked"
  /\ clock' = clock + 1 /\ relAt' = [relAt EXCEPT ![cur] = clock + 1]
  /\ phase' = "merged"
  /\ UNCHANGED <<opened, mergedAt, note, label, cur, published, shippedStale>>

\* Check 2, refuseLateUnrecorded (release.ts:606-618): the pull requests the release commit
\* carries, and the notes on main's tip. Then npm stage publish, pinned to the release commit.
Stage ==
  /\ phase = "merged"
  /\ NoStale(clock) /\ Recorded(relAt[cur] - 1)
  /\ phase' = "staged"
  /\ UNCHANGED <<opened, mergedAt, note, label, cur, published, relAt, clock, shippedStale>>

\* A person approves the staged release with a one-time code; npm serves it.
Approve ==
  /\ phase = "staged"
  /\ shippedStale' = (shippedStale \/ ~NoStale(relAt[cur]))
  /\ published' = published \cup {cur} /\ cur' = cur + 1 /\ phase' = "idle"
  /\ UNCHANGED <<opened, mergedAt, note, label, relAt, clock>>

Next == \/ \E p \in PRs, n \in BOOLEAN, l \in BOOLEAN : Open(p, n, l)
        \/ \E p \in PRs : Merge(p) \/ FixNote(p)
        \/ StartRelease \/ MergeRelease \/ Stage \/ Approve
Spec == Init /\ [][Next]_vars

\* 9a. Every merged PR that a published release contains has a note (or the label).
ShippedHasNote == \A p \in PRs, v \in published :
  (mergedAt[p] /= 0 /\ mergedAt[p] < relAt[v]) => (note[p] /= 0 \/ label[p])
\* 9b. No note sits under a version that was already published when its PR merged.
NoNoteUnderPublished == \A p \in PRs :
  (mergedAt[p] /= 0 /\ note[p] \in published) => mergedAt[p] < relAt[note[p]]
\* 9b, as a release can enforce it: no published release carries such a note.
NoReleaseOverStaleNote == ~shippedStale
====
