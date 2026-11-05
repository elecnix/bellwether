# Bellwether test brief: the missing tiers

The design document is `bellwether-design.html` in this directory. It names four test tiers. The repo today has only three test files: `test/unit/claude-transcript.test.ts`, `test/unit/packaging.test.ts`, and `test/integration/claude-channel.test.ts`. The gap is tier 1 for the core, tier 2 entirely, and tier 3 entirely.

Your job is tier 1 first. Do not touch tier 2 or tier 3 yet.

## What already exists

`src/core/classifier.ts` is a pure function of `(state, clock, observation)`, so it runs against a fake clock with no socket. `src/core/outbox.ts` merges pending entries per child and carries receipts. `src/core/registry.ts` reads and writes one JSON file per parent session under `~/.bellwether/parents/`.

Read those three files before writing anything. Read the design document's "Child events", "Parts and how they connect" and "Testing in a separate herdr instance" sections.

## Tier 1: what to add

Add these test files under `test/unit/`, one concern per file:

- `classifier.test.ts`: the settle times. An idle child that goes busy again inside `idleMs` sends no event. One that stays idle past `idleMs` sends one. A blocked child waits `blockedMs` before its dialog is reported. A working child whose transcript stops growing for `stuckMs` fires once, not on every later observation. A new `completionSeq` starts a fresh turn, and a report that already covered that turn suppresses the idle event. Drive all of this from a fake clock you control, with no timers and no socket.

- `outbox.test.ts`: merging and receipts. A newer state for the same child replaces an older pending entry rather than appending. Several children changing at once produce one merged message. A receipt that appears in the parent's context marks the entry read. A repeated receipt is dropped. An unread entry survives a registry reload.

- `registry.test.ts`: persistence. A child record is written before `tab.create` is called. A reload reads the same record. A resumed parent session sees its children. A malformed file does not crash the reader.

## How to run

`npm run test:unit` runs every file matching `test/unit/**/*.test.ts` through Node's built-in test runner. Run it after each file. All existing tests must keep passing.

## Rules

- Node's built-in `node:test` and `node:assert`. No new dependencies.
- No real timers in tier 1: pass a clock function into the code under test. If a function hard-codes `Date.now()`, inject the clock rather than mocking the global.
- No socket, no herdr server, no network.
- Each test must fail for the right reason before it passes. Say in the PR body which assertion you saw fail first.
- Leave the code under test alone unless a test exposes a real defect. If it does, fix the defect and say so in the PR body.
