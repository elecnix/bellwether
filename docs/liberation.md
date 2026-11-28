# Freeing a child

A parent can free a child that no longer needs supervision. The child leaves the parent's registry and becomes a peer, addressed by its child id. The parent stops hearing about the child's turns, stops tracking its briefs and stops taking its reports. Afterward, the child and its former parent can still message each other as peers.

```text
agent_free child=writer reason="it owns the docs now"
bellwether free writer --reason "it owns the docs now"
```

## What changes for the parent

- No `idle`, `blocked`, `stuck`, `inactive` or `exited` event about the child starts the parent's turn. The watcher drops the child's pane and its unread events.
- The child's briefs leave the parent's record and go to the child's own record.
- A report from the child, whether from its tool or its shell, goes nowhere, and the daemon tells the child why.
- `agent_list` and the roster line leave the child out. The registry keeps the child under `freed`, recording its id, its name, when it left, who freed it and why.
- `agent_send`, `agent_read`, `agent_stop` and a resume through `agent_spawn` refuse the child by name and give its address.

Freeing is permanent. No call takes a freed child back.

## Changes for the freed child

Bellwether delivers a notice into the child's session without typing it into the pane, and the notice identifies the former parent and gives its address.

Because no parent answers `parent_report`, `agent_request_depth` or `request_retirement`, the child loses all three. It keeps every tool that any session has, including `peer_send`.

The daemon on the child's machine writes the child's own record to `~/.bellwether/peers/<child id>.json`, with mode 0600. That record shows who freed the child and when, along with the briefs it received. One entry records the former parent's address and the pair's token, and the parent's daemon writes a matching entry to the parent's own file.

## Messages between peers

`peer_send` takes an address and a text.

```text
peer_send to=a1b2c3d4e5f60718 text="Is the build green?"
```

A message to a freed child enters its session the way a parent's message does. If the session doesn't take it, the daemon types nothing into the pane, since the sender no longer controls that pane.

A former parent receives a message as a `peer-message` event at its next turn, and the event explains how to reply.

Each side knows only the addresses its own record lists. No call lists another agent's peers, and a freed child cannot list its former siblings. When a caller gives an address it doesn't hold, the refusal lists only that caller's own contacts.

## The peer token

At freeing, the parent's daemon draws a random 256-bit token for the pair, and each side's record stores it. Each message includes its sender's address and the token, and the target's daemon checks that token against the copy its record stores for that sender. A message with a missing or wrong token gets dropped.

This design follows the sealed relay that [#209](https://github.com/elecnix/bellwether/issues/209) proposes, where holding an address also requires the token.

A first authentication step, the token still leaves these gaps:

- A process of the same user can read the record files.
- A process of the same user can connect to the daemon socket and claim a child id, because the daemon still takes an adapter's identity on trust.
- Someone who captures a message can replay it, since nothing numbers messages.
- No call rotates or revokes a token.

## A child on another machine

Freeing ends the parent's ownership of the child. The relay connection remains, but only for the pair's messages. Only the parent's daemon dials, so it keeps the SSH connection to the child's machine open while a freed child runs there.

When freeing starts, the parent's daemon sends `relay-free` over the link. The daemon on the child's machine writes the child's record there and marks its relay record freed. As before, that machine doesn't store an address for the parent's machine.

A message from the parent crosses the link with the token, and the daemon there checks it. A message from the child waits in its machine's relay outbox, as a report did, and the parent's daemon checks its token on collection.

A far daemon older than `relay-free` rejects the request as unknown. Freeing then stops before either machine changes.

## Refusals

`agent_free` refuses the following children and leaves everything unchanged:

- an adopted child, which has no parent record to leave;
- a child that has exited, since no session remains to receive messages at its address;
- a child that is crossing to another machine;
- a child with a restart or a teleport pending;
- a child that has asked for retirement;
- a child with no record that it has read its newest brief, since no one would deliver that brief afterward.

## Freed worktrees

Nobody reaps a freed child's worktree. The daemon retires only a parent's child, so the worktree and branch stay where they are, and the freed child owns them. For that reason, the freed child loses `request_retirement`.

## Doctor

`bellwether doctor` prints one line for each child that a session on the machine freed, and one line for each freed agent whose record the machine stores. No doctor line prints a token.
