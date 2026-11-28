# Design matrix

In axiomatic design, each functional requirement (FR) is a row, and each design parameter (DP) is a column. Row i and column j contain a filled cell when DP j must change for FR i to change. Filled cells that sit only on the diagonal make the matrix uncoupled, so each module changes alone.

A lower-triangular matrix decouples its modules. They change in a fixed order, and a change moves only forward along that order. Any other matrix couples its modules, so a fix to one module can break a requirement that another module serves.

Bellwether at `f3fe3a7` on `main` has a coupled matrix.

## Verdict

The matrix is neither lower-triangular nor diagonal under any ordering of the requirements.

- **Coupled set.** 18 of the 21 design parameters form one coupled set. Only the child record's storage (`registry.ts`), the protocol (`features.ts`, `protocol.ts`) and `move.ts` stand outside it. Under the ordering used below, 85 cells sit above the diagonal.
- **Where the coupling runs.** The runtime imports between these modules don't form a cycle, so the code on its own is lower-triangular. Every cell above the diagonal traces to a child record field that one module writes and another reads.
- **The way out.** Fields belong to five families: incarnation, message delivery, authority, retirement and pending requests. Give each family one owner, and the matrix becomes lower-triangular, with no cell above the diagonal. Each family matters: with any four of them owned, a coupled set remains.
- **The diagonal is unattainable, and reaching it is not the goal.** Spawn needs brief delivery, brief delivery needs messaging, and every lifecycle operation needs the record. Those cells fall below the diagonal, where they belong.

## Method

One source file, or a small set of them, makes up each design parameter. Row *i* and column *j* contain a filled cell when either of these holds:

- **I**: the module for FR *i* imports module *j* at runtime. A type-only import does not count.
- **D**: the module for FR *i* reads a field of the child record (or of a message or brief on it) that module *j* writes.
- **B**: both.

Reads take the form `child.field`, `entry.field` or `record.field`. The code calls a child record `child`, `entry` or `record`: `updateChild` callbacks use `entry` 83 times out of 99. Writes are assignments, `delete` calls, or, for fields whose names nothing else uses, object literal keys. The method skips fields that every object carries, such as `id`, `name` and `at`.

Dependencies that no file shows as a field or an import fall outside the matrix. One runs through herdr. The other runs through a copy:

- Herdr. `restart.ts` closes a pane, and `watcher.ts` reacts to `pane.closed`. `restart.ts` and `watcher.ts` agree on what that event means without sharing a field.
- Copies. A spread such as `{ ...child }` carries fields across without listing them.

So the matrix understates the coupling and never overstates it, apart from one case. Fields with a stable meaning, such as `paneId`, fill one cell per reading module. That cell is still correct under the test. If the meaning of `paneId` changed, each of those modules would have to change.

## Functional requirements and design parameters

Each requirement has one design parameter, listed in the dependency order that the refactor below makes lower-triangular.

| # | Functional requirement | Design parameter |
|---|---|---|
| 1 | A daemon remembers each child across its own restarts. | child record: `core/types.ts`, `core/registry.ts` |
| 2 | The machine that runs a child remembers it, with no address for the parent's machine. | relay record: `core/relay-records.ts` |
| 3 | Releases sharing one machine agree on what each can do. | `daemon/features.ts`, `daemon/protocol.ts` |
| 4 | Each place a child left by a move remains on record until retirement handles it. | `core/departures.ts` |
| 5 | A parent's message enters the child's session once. | `core/send.ts` |
| 6 | The child's model takes its brief once. | `core/brief-delivery.ts` |
| 7 | A child starts in a new pane, with its brief. | `core/spawn.ts` |
| 8 | A child's report reaches the parent that owns it. | `core/report.ts` |
| 9 | One pane has at most one parent, across machines. | `core/pane-claims.ts` |
| 10 | A worktree goes once its work is safe, and never otherwise. | `core/retire.ts` |
| 11 | A child whose pane has closed comes back from its record. | `core/resume.ts`, `core/spawn-resume.ts` |
| 12 | `agent_list` and `doctor` say what became of each pane. | `core/pane-fate.ts`, `core/hygiene.ts` |
| 13 | The same child and session come back in a new pane. | `core/restart.ts` |
| 14 | Bellwether copies a session to another machine and verifies the copy. | `core/carry.ts` |
| 15 | A crossing that a daemon stop cut short finishes or rolls back. | `core/recover-crossing.ts` |
| 16 | A parent moves a child on request. | `core/move.ts` |
| 17 | A child, live or stopped or the caller itself, crosses and receives a notice of where it is. | `core/teleport.ts` |
| 18 | A session Bellwether did not start becomes a child. | `core/adopt.ts` |
| 19 | The parent hears each change in a child's state once. | `core/watcher.ts` |
| 20 | A call or a report goes to the machine that runs the child. | `daemon/relay-links.ts` |
| 21 | Each call and each adapter receipt goes to the code that handles it. | `daemon/server.ts` |

Freeing a child ([#262](https://github.com/elecnix/bellwether/issues/262)) is not on `main`, so it has no row. The issue gives its intent. A freed child keeps an address, and its former parent no longer holds its events, briefs and reports. That change falls in the authority family below, so it should wait until that family has an owner.

## The matrix as it stands

Bold cells sit above the diagonal. Each one is a dependency that runs against the order, so a change to the module in that column can break the requirement in that row.

| # | FR, DP | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| 1 | record | X | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · |
| 2 | relayrec | I | X | · | · | · | · | · | · | · | · | · | · | · | · | · | · | **D** | · | · | · | · |
| 3 | proto | I | · | X | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · |
| 4 | departures | I | · | · | X | · | · | · | · | · | · | · | · | · | · | **D** | · | · | **D** | · | · | · |
| 5 | send | I | · | · | · | X | **D** | **D** | · | · | · | **D** | · | **D** | **D** | **D** | · | **D** | **D** | **D** | · | **D** |
| 6 | brief | I | · | · | · | B | X | **D** | · | · | · | **D** | · | **D** | · | **D** | · | **D** | **D** | · | · | **D** |
| 7 | spawn | I | · | · | · | · | I | X | · | · | · | **D** | · | **D** | · | **D** | · | **D** | **D** | **D** | · | **D** |
| 8 | report | I | I | · | · | · | · | D | X | · | · | **D** | · | **D** | **D** | **D** | · | · | **D** | **D** | · | **D** |
| 9 | claims | I | I | · | · | · | · | D | · | X | **D** | **D** | · | **D** | · | **D** | · | · | **D** | **D** | · | **D** |
| 10 | retire | I | · | · | I | · | · | D | I | · | X | **D** | · | **D** | **D** | **D** | · | **D** | **D** | **D** | · | **D** |
| 11 | resume | I | · | · | · | B | B | B | · | · | B | X | · | **D** | **D** | **D** | · | **D** | **D** | **D** | · | **D** |
| 12 | list | I | · | · | · | · | · | D | · | · | D | D | X | **D** | **D** | **D** | · | · | **D** | **D** | · | **D** |
| 13 | restart | I | I | D | · | D | D | B | I | · | I | B | I | X | **D** | **D** | · | **D** | **D** | **D** | **D** | **D** |
| 14 | carry | I | · | · | I | · | D | B | · | · | · | B | · | D | X | **D** | · | **D** | **D** | **D** | · | **D** |
| 15 | recover | I | · | · | I | · | · | D | · | · | · | B | · | D | B | X | · | · | **D** | **D** | · | **D** |
| 16 | move | · | · | · | · | · | · | · | · | · | · | · | · | · | I | · | X | · | · | · | · | · |
| 17 | teleport | I | · | · | · | D | D | D | I | · | · | D | · | B | B | D | · | X | **D** | **D** | · | **D** |
| 18 | adopt | I | I | · | · | · | · | B | · | I | I | D | · | D | D | D | · | D | X | **D** | **D** | **D** |
| 19 | watcher | I | I | D | · | I | · | D | I | I | I | D | · | B | D | D | · | D | B | X | · | **D** |
| 20 | links | I | · | I | I | I | · | B | · | I | · | D | · | D | D | D | · | D | B | D | X | **D** |
| 21 | server | I | I | I | I | B | D | D | I | I | B | D | I | B | D | D | · | B | D | D | I | X |

## The coupled set

Rows and columns 2 and 4 to 21, apart from 16, form one strongly connected set. Every module in it depends, through some chain of fields, on every other. The table below lists the fields that bind the set together, and the modules that write each one:

| Field | Writers | Family |
|---|---|---|
| `undelivered` | send, brief-delivery, resume, carry, recover-crossing, teleport, watcher, server | delivery |
| `lastStatus` | spawn, resume, restart, recover-crossing, teleport, adopt, watcher | incarnation |
| `paneId` | spawn, resume, restart, recover-crossing, adopt, server | incarnation |
| `exitedAt` | resume, restart, carry, recover-crossing, adopt, watcher | incarnation |
| `tabId`, `session` | spawn, resume, restart, recover-crossing, adopt or watcher | incarnation |
| `startingUntil` | spawn, resume, restart, recover-crossing | incarnation |
| `exitCode`, `harnessEnded`, `harnessSeenAt`, `tabClosedAt`, `reportPending` | resume, restart, adopt, watcher | incarnation |
| `readAt` | brief-delivery, teleport, server | delivery |
| `messages`, `relayInDoubt` | send, server | delivery |
| `origin` | spawn and adopt at creation, read as a policy by eight modules | authority |
| `retireIntent`, `retireRequestedAt` | retire, carry | retirement |
| `teleportRequest`, `restartRequestedAt`, `moving` | relay-links and teleport, restart, carry and recover-crossing | requests |

No module defines what any of these fields means. Each writer decides for itself what a field means at the moment it writes it.

### Field clearing at run start

The incarnation family shows the cost most plainly. Code in five places marks a child as running again. Each place clears a different set of the fields that a previous run left behind:

| Field cleared | `resume.ts` | `restart.ts` | `adopt.ts` `backInPane` | `spawn-resume.ts` | `recover-crossing.ts` |
|---|:-:|:-:|:-:|:-:|:-:|
| `exitedAt` | yes | yes | yes | yes | yes |
| `exitCode` | yes | yes | yes | yes | |
| `harnessEnded` | yes | yes | yes | yes | |
| `tabClosedAt` | yes | yes | yes | yes | |
| `harnessSeenAt` | yes | yes | | | |
| `reportPending` | yes | | yes | | |
| `paneEnd` | | yes | | | |
| `startingUntil` | | yes | | | yes |
| `closing`, `restartInDoubt`, `restartRequestedAt` | | yes | | | |
| `restartFailed` | yes | yes | | | |
| `crossingFailed` | yes | | | | |
| `awaitsResume` | | | yes | | |
| retirement (`clearRetirement`) | yes | yes | yes | | |

The code doesn't say which of these differences are deliberate, so the analysis doesn't call any gap a defect. Its claim is narrower: a reader can't tell deliberate ones from accidental ones. A developer who adds a field that marks the end of a run must add it to the right subset of five places. No check catches a missed place.

## Tonight's defects as filled cells

A defect whose fix touches two modules is a filled cell in two columns. Several of the issues filed on the night of 27 to 28 November 2026 are the same coupling seen from different sides.

- **`origin` decides five policies.** [#256](https://github.com/elecnix/bellwether/issues/256): a resumed adopted child keeps `origin: 'adopt'`. `watcher.ts` reads that value as "a new session in the pane ends this child", so a `/clear` ends it. `retire.ts` reads the same value as "never remove this worktree", `restart.ts` as "never close this pane", `teleport-plan.ts` as "refuse to carry it", and `watcher.ts` again as "answer no startup dialog". The fix needs a decision about retirement, because one field carries all five meanings. These are cells (19, 11), (10, 11), (13, 11) and (17, 11).
- **A brief taken twice.** [#176](https://github.com/elecnix/bellwether/issues/176), [#211](https://github.com/elecnix/bellwether/issues/211) and [#246](https://github.com/elecnix/bellwether/issues/246): `readAt`, `takenAt`, `takenBy` and `undelivered` record the brief's state. `server.ts` sets `readAt` when a receipt arrives and deletes `undelivered`. `brief-delivery.ts` reads `readAt` and sets `undelivered`. `resume.ts` sets `undelivered` on a brief it passes on. `takenBy: 'read'` meant one thing before 0.1.10 and another after. These are cells (6, 21), (5, 6) and (11, 6).
- **A message delivered twice, or delivered after an error.** [#218](https://github.com/elecnix/bellwether/issues/218) and [#234](https://github.com/elecnix/bellwether/issues/234): `send.ts` and `server.ts` both write `messages`, `relayInDoubt` and `undelivered` for one message. These are cells (5, 21) and (21, 5).
- **`movedFrom`.** [#241](https://github.com/elecnix/bellwether/issues/241), [#227](https://github.com/elecnix/bellwether/issues/227) and [#243](https://github.com/elecnix/bellwether/issues/243): one field that retirement, the relay drain and the move all read. The fix for #241 gave the field an owner, `departures.ts`, with `departuresOf`, `recordDeparture` and `dropDeparture`. `movedFrom` and `departures` now have one writer, and row 4 has only two cells above the diagonal, both from the `host` and `cwd` it reads. #243 is still open, because `retireOnStop` refuses through `outOfBounds`, which reads `origin` and `host`. That is the authority and incarnation families again.
- **One child, two records.** [#219](https://github.com/elecnix/bellwether/issues/219): the parent's child record and the far machine's relay record disagreed about one child, and delivery fell back to typing. Column 2 has no owner that compares the two.
- **Claims.** [#244](https://github.com/elecnix/bellwether/issues/244), [#257](https://github.com/elecnix/bellwether/issues/257) and [#258](https://github.com/elecnix/bellwether/issues/258): `pane-claims.ts` decides from `paneId`, `session` and `retiredAt`, which seven other modules write. These are row 9's cells above the diagonal.

## Does the child record cause the coupling?

The parent's reading was that the coupling runs through the child record. That record is a shared, mutable structure, and nobody defines what each field means. The code supports that reading. With the record's fields taken out of the analysis, the imports alone don't form a cycle. With the fields in, 18 modules form one coupled set.

The code refines the remedy in two ways.

- **Five owners, not one.** A module that owned every field would also be lower-triangular, because column 1 holds it and every row may depend on column 1. But every requirement would then change that module, and a change made for one requirement would affect every row. Splitting ownership across five narrows that reach, because a change to the incarnation family touches only the rows that read the incarnation.
- **Which five.** The incarnation, delivery, authority, retirement and request families are each necessary. Owning any four leaves a coupled set, and owning all five leaves none. A sixth family, the turn bookkeeping (`turnNotified`, `lastReport`), does not affect triangularity.

`departures.ts` is the pattern each owner should follow. It is a small module that holds the only writes to its fields and exposes named transitions. It came from a defect, [#241](https://github.com/elecnix/bellwether/issues/241), and the matrix shows it working. No module but `departures.ts` writes `movedFrom` or `departures`.

## The matrix after the refactor

With the five owners in place as design parameters 2 to 6, the matrix has no cell above the diagonal. The D cells left come from `ownsWorkspace`, which `protocol.ts`, `spawn.ts` and `restart.ts` write, and from the turn bookkeeping. All of them fall below the diagonal.

<details>
<summary>The 26 by 26 matrix after the refactor</summary>

| # | FR, DP | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24 | 25 | 26 |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| 1 | record | X | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · |
| 2 | requests | I | X | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · |
| 3 | delivery | I | · | X | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · |
| 4 | incarnation | I | · | · | X | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · |
| 5 | authority | I | · | · | · | X | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · |
| 6 | retirement | I | · | · | · | · | X | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · |
| 7 | relayrec | I | I | · | · | · | · | X | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · |
| 8 | proto | I | · | · | · | · | · | · | X | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · |
| 9 | departures | I | · | · | I | · | · | · | · | X | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · |
| 10 | send | I | · | I | I | · | · | · | · | · | X | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · |
| 11 | brief | I | · | I | I | · | · | · | · | · | I | X | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · |
| 12 | spawn | I | · | I | I | I | · | · | · | · | · | I | X | · | · | · | · | · | · | · | · | · | · | · | · | · | · |
| 13 | report | I | · | · | I | · | · | I | · | · | · | · | · | X | · | · | · | · | · | · | · | · | · | · | · | · | · |
| 14 | claims | I | · | · | I | · | I | I | · | · | · | · | · | · | X | · | · | · | · | · | · | · | · | · | · | · | · |
| 15 | retire | I | · | · | I | I | I | · | · | I | · | · | · | I | · | X | · | · | · | · | · | · | · | · | · | · | · |
| 16 | resume | I | I | I | I | I | I | · | · | · | I | I | I | · | · | I | X | · | · | · | · | · | · | · | · | · | · |
| 17 | list | I | I | · | I | · | I | · | · | · | · | · | · | · | · | · | · | X | · | · | · | · | · | · | · | · | · |
| 18 | restart | I | I | I | I | I | · | I | D | · | · | · | B | I | · | I | I | I | X | · | · | · | · | · | · | · | · |
| 19 | carry | I | I | I | I | I | I | · | · | I | · | · | I | · | · | · | I | · | · | X | · | · | · | · | · | · | · |
| 20 | recover | I | I | I | I | · | · | · | · | I | · | · | · | · | · | · | I | · | · | I | X | · | · | · | · | · | · |
| 21 | move | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | I | · | X | · | · | · | · | · |
| 22 | teleport | I | I | I | I | I | · | · | · | · | · | · | · | I | · | · | · | · | I | I | · | · | X | · | · | · | · |
| 23 | adopt | I | · | · | I | I | · | I | · | · | · | · | I | · | I | I | · | · | · | · | · | · | · | X | · | · | · |
| 24 | watcher | I | · | I | I | I | · | I | D | · | I | · | D | I | I | I | · | · | B | · | · | · | · | B | X | · | · |
| 25 | links | I | · | · | I | I | · | · | I | I | I | · | I | · | I | · | · | · | · | · | · | · | · | I | · | X | · |
| 26 | server | I | · | I | I | I | I | I | I | I | I | · | · | I | I | I | · | I | I | · | · | · | I | · | · | I | X |

</details>

## The refactor, in order

Each step moves the writes of one family into one module and adds the family to an ownership gate.

A unit test in the style of `test/unit/pane-fallbacks.test.ts` forms the gate. It fails when a module other than the owner assigns or deletes an owned field.

A step that only moved code would pass the existing suite and decouple nothing. With the gate, one file contains every write to the family's fields, and the step becomes a decoupling.

The order follows the number of cells above the diagonal that each step removes, measured with the same script and the same ordering of rows:

| Step | Family | Cells above the diagonal after the step |
|---|---|:-:|
| 0 | none | 85 |
| 1 | incarnation | 38 |
| 2 | delivery | 21 |
| 3 | authority | 10 |
| 4 | requests | 4 |
| 5 | retirement | 0 |

The parent's brief asked for the smallest change first. The numbers argue against it. Authority is the smallest family, but owning it first removes 2 cells, and delivery after it removes 3 more. Incarnation is the largest family, and owning it first removes 47 of the 85.

### Step 1, the incarnation family

Tracked in [#277](https://github.com/elecnix/bellwether/issues/277).


The fields are `paneId`, `tabId`, `host`, `cwd`, `session`, `lastStatus`, `startingUntil`, `exitedAt`, `exitCode`, `harnessEnded`, `harnessSeenAt`, `tabClosedAt`, `paneEnd`, `reportPending`, `resumedAt`, `restartFailed`, `crossingFailed`, `awaitsResume`, `closing` and `restartInDoubt`.

The owner offers two transitions, a run that ends and a run that starts in a pane. Calls to the second come from the five places in the table of cleared fields, so those places clear the same fields by construction. Every field of `ChildRecord` gets a lifetime, per child or per run, in a table that `satisfies Record<keyof ChildRecord, Lifetime>`, so a new field without a lifetime fails the typecheck.

### Step 2, the delivery family

Tracked in [#278](https://github.com/elecnix/bellwether/issues/278).

This family holds eight fields: `readAt`, `undelivered`, `relayInDoubt`, `receivedAt`, `takenAt`, `takenBy`, `messages` and `briefs`.

Writes to these fields now all go through `src/core/delivery.ts`, and `test/unit/delivery-owner.test.ts` fails on a write anywhere else. Coverage extends to `typedInDoubt`, `readFrom`, `resentFrom`, `via`, `delivery` and the two fields the step added, `held` and `unanswered`.

Each message is in one of nine phases. A `TRANSITIONS` table lists each allowed move, and the owner refuses any other. A person reads seven words for them: sending, held, pushed, in doubt, typed, read and undelivered. `server.ts`, `send.ts`, `brief-delivery.ts`, `resume.ts`, `spawn.ts`, `teleport.ts`, `carry.ts` and `watcher.ts` call transitions, and the modules that read the fields, such as `brief-history.ts` and `restart.ts`, ask the owner for the phase.

### Step 3, the authority family

Tracked in [#279](https://github.com/elecnix/bellwether/issues/279).

The fields are `origin`, `replacedBy`, `adoptInDoubt` and `farRecordLost`.

The owner replaces each `origin === 'adopt'` comparison with a named question, covering whether Bellwether may:

- type into the pane
- close it
- retire the worktree
- answer the startup dialogs
- carry the child
- end it when another session appears in the pane

With this step, the decision that [#256](https://github.com/elecnix/bellwether/issues/256) needed is one line, `heldByAdoption` in `src/core/authority.ts`. Freeing a child, [#262](https://github.com/elecnix/bellwether/issues/262), belongs after this step.

Every write to these fields and every comparison of `origin` now goes through that module, and `test/unit/authority-owner.test.ts` fails on either anywhere else. Its decision table, given in [authority](authority.md), covers typing into the pane as the message act of `agent_send`.

### Steps 4 and 5: requests and retirement

`relay-links.ts` stops writing `teleportRequest`, and `recover-crossing.ts` stops writing `moving`, each through the module that defines the request. `carry.ts` stops writing `retireIntent` and `retireRequestedAt` and calls `retire.ts`, which already contains every other write to the retirement fields.

## Reproducing the matrix

The cells come from a script. As it walks `src/`, the script maps each file to its design parameter and records its runtime imports and its field reads and writes, as Method describes them.

Next it finds the strongly connected sets of the resulting graph, and repeats with each family's fields routed to an owner.

The script is not in the repository. The ownership gate in step 1 replaces it with a check that CI runs, one family at a time.
