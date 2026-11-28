---- MODULE Release ----
\* Release notes and the release script (scripts/release.ts, scripts/release-notes.ts), at 2645cf4.
\* Invariant 9. A note is a file under release-notes/<version>/. The only check is
\* refuseUnrecorded (release.ts:544-553), run when a release is cut, over the pull
\* requests merged since the previous release commit (mergedSince, release.ts:561-578).
EXTENDS Naturals

CONSTANTS PRs, MaxV

VARIABLES
  opened,     \* PR -> BOOLEAN
  mergedAt,   \* PR -> position on main's first-parent history, 0 while open
  note,       \* PR -> version directory of its note, 0 for none
  label,      \* PR -> carries "release-note: none"
  cur,        \* the version the next release cuts (package.json + 1)
  published,  \* versions npm serves
  relAt,      \* version -> position of its "release: V" commit, 0 if unreleased
  phase,      \* "idle" or "checked": the release worktree was taken and passed the check
  clock

vars == <<opened, mergedAt, note, label, cur, published, relAt, phase, clock>>

LastRel == IF cur = 1 THEN 0 ELSE relAt[cur - 1]

Init == opened = [p \in PRs |-> FALSE] /\ mergedAt = [p \in PRs |-> 0] /\ note = [p \in PRs |-> 0]
        /\ label = [p \in PRs |-> FALSE] /\ cur = 1 /\ published = {} /\ relAt = [v \in 1..MaxV |-> 0]
        /\ phase = "idle" /\ clock = 0

\* A PR opens with a note for the version that is next at that moment, or none, or a label.
Open(p, withNote, lab) ==
  /\ ~opened[p] /\ opened' = [opened EXCEPT ![p] = TRUE]
  /\ note' = [note EXCEPT ![p] = IF withNote THEN cur ELSE 0]
  /\ label' = [label EXCEPT ![p] = lab]
  /\ UNCHANGED <<mergedAt, cur, published, relAt, phase, clock>>

Merge(p) ==
  /\ opened[p] /\ mergedAt[p] = 0
  /\ clock' = clock + 1 /\ mergedAt' = [mergedAt EXCEPT ![p] = clock + 1]
  /\ UNCHANGED <<opened, note, label, cur, published, relAt, phase>>

InWindow(p) == mergedAt[p] > LastRel

\* openReleasePr takes origin/main and runs refuseUnrecorded: every PR merged since the
\* previous release commit has a note or feature under cur, or the label.
StartRelease ==
  /\ phase = "idle" /\ cur <= MaxV
  /\ \A p \in PRs : (mergedAt[p] /= 0 /\ InWindow(p)) => (note[p] = cur \/ label[p])
  /\ phase' = "checked"
  /\ UNCHANGED <<opened, mergedAt, note, label, cur, published, relAt, clock>>

\* The release check stops; someone files the missing note under cur.
FixNote(p) ==
  /\ phase = "idle" /\ mergedAt[p] /= 0 /\ InWindow(p) /\ note[p] /= cur /\ ~label[p]
  /\ note' = [note EXCEPT ![p] = cur]
  /\ UNCHANGED <<opened, mergedAt, label, cur, published, relAt, phase, clock>>

\* The release PR squash-merges onto main (after anything merged meanwhile) and npm publishes.
FinishRelease ==
  /\ phase = "checked"
  /\ clock' = clock + 1 /\ relAt' = [relAt EXCEPT ![cur] = clock + 1]
  /\ published' = published \cup {cur} /\ cur' = cur + 1 /\ phase' = "idle"
  /\ UNCHANGED <<opened, mergedAt, note, label>>

Next == \/ \E p \in PRs, n \in BOOLEAN, l \in BOOLEAN : Open(p, n, l)
        \/ \E p \in PRs : Merge(p) \/ FixNote(p)
        \/ StartRelease \/ FinishRelease
Spec == Init /\ [][Next]_vars

\* 9a. Every merged PR that a published release contains has a note (or the label).
ShippedHasNote == \A p \in PRs :
  (mergedAt[p] /= 0 /\ mergedAt[p] < LastRel) => (note[p] /= 0 \/ label[p])
\* 9b. No note sits under a version that was already published when its PR merged.
NoNoteUnderPublished == \A p \in PRs :
  (mergedAt[p] /= 0 /\ note[p] \in published) => mergedAt[p] < relAt[note[p]]
====
