# Who may act for a child

Before a parent acts on a child, Bellwether checks whether that parent may act for it. The module `src/core/authority.ts` gives the answer. It reads five fields on the child record: `origin`, `adoptInDoubt`, `claimUnconfirmed`, `farRecordLost` and `replacedBy`. It is the only module that writes them.

## Sources of authority

Bellwether reads a child's holder from these sources:

- **A registry.** Each parent's registry on its own machine lists its children.
- **A claim.** A parent adopting a pane on a second machine leaves a claim in that machine's relay records.
- **A peer book.** Once freed, a child keeps a peer book instead of a parent ([#262](https://github.com/elecnix/bellwether/issues/262)) and leaves its parent's registry, so a parent's act finds it by name only to refuse with the address to use instead.

When two of these sources identify the same pane or child, and Bellwether cannot tell which one is right, it refuses. The refusal lists both sources. Bellwether doesn't pick one.

## Standings

Each child has one standing, read from its record:

| Standing | When |
|---|---|
| started | Bellwether started the child, by a spawn or a resume. An adopted child that a resume relaunched in a tab Bellwether opened counts too ([#256](https://github.com/elecnix/bellwether/issues/256)). |
| adopted | The parent adopted a pane on its own machine. |
| claimed | The parent adopted a pane on another machine, and its claim stands there. |
| stale | The child's machine lost its record of the child, as after a reboot, and nobody else holds the pane there. |
| unconfirmed | The relay lost the answer to an adoption on another machine. Or the relay came back, and since then that machine has not confirmed the claim ([#257](https://github.com/elecnix/bellwether/issues/257)), or that a started child still runs in its pane there ([#298](https://github.com/elecnix/bellwether/issues/298)). |
| contested | The child's machine holds the pane for someone else: another parent, or this parent under another child id. |
| replaced | The child's machine holds the session under another child id. |
| freed | The child has no holding parent any longer. |

## The decision table

Standings label the rows, and the acts a parent requests label the columns. A "yes" records only the authority's answer, since the act's own module can still refuse, such as when the child is moving or has no recorded session.

| Standing | message | restart | resume | move | teleport | retire | free |
|---|---|---|---|---|---|---|---|
| started | yes | yes | yes | yes | yes | yes | yes |
| adopted | yes | no (1) | yes | no (2) | no (3) | no (4) | no (5) |
| claimed | yes | no (1) | yes | no (2) | no (3) | no (4) | no (5) |
| stale | as its holding row | as its holding row | as its holding row | as its holding row | as its holding row | as its holding row | as its holding row |
| unconfirmed | no (6) | no (6) | no (6) | no (6) | no (6) | no (6) | no (6) |
| contested | no (7) | no (7) | no (7) | no (7) | no (7) | no (7) | no (7) |
| replaced | no (8) | no (8) | no (8) | no (8) | no (8) | no (8) | no (8) |
| freed | no (9) | no (9) | no (9) | no (9) | no (9) | no (9) | no (9) |

The reasons:

1. A restart closes the old pane, and Bellwether closes only panes it started.

2. A move closes the pane it leaves, and Bellwether closes only panes it started.

3. The parent's record and the daemon that runs the pane can disagree, and a teleport would carry that disagreement to the destination ([#219](https://github.com/elecnix/bellwether/issues/219)).

4. Bellwether never removes the worktree of a child it did not start.

5. The adopted session has no parent record to leave. Stop watching it with `agent_stop` instead.

6. Whether this parent or another holds the pane, the record doesn't say. The watcher queries that machine again, and the act waits for the answer.

7. Where the sources disagree, the refusal lists both. Stop the child under the parent that shouldn't hold it, or adopt the pane again once the other holder releases it.

8. An act goes to the child id that now stands for the session.

9. This child has no holding parent. Reach it with `peer_send` at its address.

Stale rows answer as the row for how the parent holds the child: started, adopted or claimed.

## Policies the daemon applies on its own

Some decisions arise without an act from a parent. `heldByAdoption` decides each of them in one line, so a change for an adopted child happens in one place:

- whether Bellwether answers the child's startup dialogs
- whether a start window applies to a harness it hasn't seen yet
- whether another session in the pane ends the child
- whether a harness that quit in its open pane may come back there as the same child
- whether the parent may make the child's claim on its machine again
- whether a session that says hello with no child id is this child, by its pane and session

## Who holds a pane

A pane on one machine can have holders from these places. Parents on that machine list it in their registries. Parents on other machines leave adoption claims there. Children that parents elsewhere started hold it through their live connections. `claimantOf` in `src/core/pane-claims.ts` counts all of them:

- An adoption claim for a session other than the one the pane runs is stale, and it counts for nothing.
- A claim yields to a child that a parent on this machine started, because Bellwether opened that pane after the claim.
- A claim yields to a started child whose adapter now holds a live connection from the pane ([#244](https://github.com/elecnix/bellwether/issues/244)).
- Any other pair of holders is a conflict. `agent_adopt` refuses, a remote adoption refuses, and a session that says hello from that pane doesn't get a parent. Each refusal lists both holders.

## What doctor prints

`bellwether doctor` prints one line for each live child. The line names who holds the child, on which machine, and by what evidence:

```
ok    authority: builder (child c-s) on this machine is started, held by parent pi-a; evidence: the registry of parent pi-a on this machine, which started it in pane w1:p2.
ok    authority: first-mate (child c-c) on machine child-box is claimed, held by parent pi-a; evidence: the registry of parent pi-a on this machine, which adopted pane w1:p2, and the claim it left on machine child-box.
warn  authority: doubtful (child c-u) on machine child-box is unconfirmed, held by parent pi-a; evidence: the registry of parent pi-a on this machine alone: machine child-box has not confirmed the claim since 2026-11-28T08:00:00.000Z.
```

When two sources disagree, doctor prints a `fail` line that lists both, and the failure counts toward doctor's exit code:

```
fail  authority: contested (child c-x) on machine child-box is contested, held by parent pi-a; evidence: Two sources of authority disagree about contested (child c-x): this parent's registry holds it in pane w1:p2 on machine child-box, and that machine's claims answer otherwise since 2026-11-28T08:00:00.000Z: pane w1:p2 is already a child of pi-other.
fail  authority: Pane w1:p2 on this machine is held by two sources of authority that disagree: the registry of parent pi-a on this machine, as child c-a (hand-started) on session S1, and the adoption claim of parent pi-far on another machine, as child c-far (far-held) on session S1. Bellwether does not pick one.
```

A pane on this machine that a parent on another machine holds gets its own line, so one machine's doctor answers for every pane on it.
