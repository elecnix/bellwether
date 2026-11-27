# Bellwether test brief: the missing tiers

`bellwether-design.html` in this directory is the design document, and it names four test tiers. The repo today has only three test files: `test/unit/claude-transcript.test.ts`, `test/unit/packaging.test.ts`, and `test/integration/claude-channel.test.ts`. Tier 1 for the core is missing, and so are tier 2 and tier 3 entirely.

Your job is tier 1 first. Do not touch tier 2 or tier 3 yet.

## What already exists

`src/core/classifier.ts` is a pure function of `(state, clock, observation)`, so it runs against a fake clock with no socket. `src/core/outbox.ts` merges pending entries per child and carries receipts. `src/core/registry.ts` reads and writes one JSON file per parent session under `~/.bellwether/parents/`.

Read those three files before writing anything. Read the design document's "Child events", "Parts and how they connect" and "Testing in a separate herdr instance" sections.

## Tier 1: what to add

Add these test files under `test/unit/`, one concern per file:

- `classifier.test.ts`: the settle times. An idle child that goes busy again inside `idleMs` doesn't send an event. One that remains idle past `idleMs` sends one. A blocked child waits `blockedMs` before the classifier reports its dialog. A working child whose transcript stops growing for `stuckMs` fires once, not on every later observation. A new `completionSeq` starts a fresh turn, and a report that already covered that turn suppresses the idle event. Drive all of this from a fake clock you control. These tests run on the fake clock alone.

- `outbox.test.ts`: merging and receipts. A newer state for the same child replaces an older pending entry rather than appending. Several children changing at once produce one merged message. The adapter's own delivered message marks the entry read, and a reload keeps the flag, while a receipt in a tool result leaves the entry unread. The outbox drops a repeated receipt, and a registry reload keeps an unread entry.

- `registry.test.ts`: persistence. The code writes a child record before it calls `tab.create`. A reload reads the same record and a resumed parent session sees its children, while a malformed file leaves the reader running.

## How to run

`npm run test:unit` runs every file matching `test/unit/**/*.test.ts` through Node's built-in test runner. Run it after each file. All existing tests must keep passing.

## Rules

- Node's built-in `node:test` and `node:assert`. No new dependencies.
- No real timers in tier 1: pass a clock function into the code under test. If a function hard-codes `Date.now()`, inject the clock rather than mocking the global.
- Keep tier 1 off the network, off sockets and away from any herdr server.
- Each test must fail for the right reason before it passes. Say in the PR body which assertion you saw fail first.
- Leave the code under test alone unless a test exposes a real defect. If it does, fix the defect and say so in the PR body.
