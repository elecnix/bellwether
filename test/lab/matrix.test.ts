// Tier 3: the four parent and child pairs, and the five child events. The Pi
// parent runs a real TUI against the scripted provider, and a child is either a
// real Pi TUI or a real Claude Code REPL. The Claude parent needs the channel
// feature, which this Claude Code build reports as unavailable, so those two
// pairs skip with that reason rather than pretend.
//
// A cell passes only when the parent's transcript has the receipt followed by
// a new assistant message, and the outbox marks that receipt read. A sent
// notification alone proves nothing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { HerdrClient } from '../../src/core/herdr-client.ts';
import { newChildId, Outbox } from '../../src/core/outbox.ts';
import { listParents, readParent, updateChild, upsertChild } from '../../src/core/registry.ts';
import { spawnChild } from '../../src/core/spawn.ts';
import type { ChildEventKind, ChildRecord, OutboxEntry, ParentRecord } from '../../src/core/types.ts';
import { hasHerdr, startLab, type Lab } from './herdr-lab.ts';
import { startScriptedModels, type ScriptedModels, type ScriptedReply } from './scripted-models.ts';
import { createPiAgentDir, hasHarness, startHarness, type LabHarness, type LabHarnessKind } from './harness-run.ts';

const herdrMissing = (await hasHerdr()) ? false : 'herdr is not on PATH';
const piMissing = (await hasHarness('pi')) ? false : 'pi is not on PATH';
const claudeMissing = (await hasHarness('claude')) ? false : 'claude is not on PATH';
/** Claude Code 2.1.318 reports channel notifications as unavailable in the lab. */
const claudeChannelsReason = 'Claude Code reports channels are not currently available, so a Claude parent cannot be woken';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until<T>(label: string, timeoutMs: number, read: () => Promise<T | undefined> | T | undefined): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await wait(200);
  }
}

/** The parent's Pi transcript file under its own agent directory. */
function findTranscript(agentDir: string, session: string): string | undefined {
  const sessions = path.join(agentDir, 'sessions');
  if (!fs.existsSync(sessions)) return undefined;
  let found: string | undefined;
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(`${session}.jsonl`)) found = full;
    }
  };
  walk(sessions);
  return found;
}

/** The newest JSONL under a lab session directory, for a child spawned at speed. */
function newestJsonl(dir: string): string | undefined {
  if (!fs.existsSync(dir)) return undefined;
  let best: { file: string; mtime: number } | undefined;
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const mtime = fs.statSync(full).mtimeMs;
        if (!best || mtime > best.mtime) best = { file: full, mtime };
      }
    }
  };
  walk(dir);
  return best?.file;
}

interface TranscriptLine {
  index: number;
  raw: string;
  entry: Record<string, unknown>;
}

function readTranscript(file: string): TranscriptLine[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((raw, index) => {
      try {
        return { index, raw, entry: JSON.parse(raw) as Record<string, unknown> };
      } catch {
        return { index, raw, entry: {} };
      }
    });
}

function isAssistant(line: TranscriptLine): boolean {
  const message = line.entry['message'];
  if (line.entry['type'] === 'assistant') return true;
  return line.entry['type'] === 'message' && typeof message === 'object' && message !== null && (message as Record<string, unknown>)['role'] === 'assistant';
}

/** The pass rule: the receipt, then a new assistant message after it. */
function receiptThenAssistant(file: string, receipt: string): boolean {
  const lines = readTranscript(file);
  const receiptAt = lines.findIndex((line) => line.raw.includes(receipt));
  if (receiptAt < 0) return false;
  return lines.slice(receiptAt + 1).some(isAssistant);
}

interface EventCase {
  event: ChildEventKind;
  prompt: string;
  expect: RegExp;
  /** The replies a Pi child receives, in order. */
  pi: ScriptedReply[];
  /** The replies a Claude child receives, in order. */
  claude: ScriptedReply[];
  /** A Pi extension that opens the blocked dialog. */
  piBlocked?: boolean;
  /** A Claude permission mode that stops a tool call at a dialog. */
  claudePermissionMode?: string;
  idleMs: number;
  blockedMs: number;
  stuckMs: number;
}

const cases: EventCase[] = [
  {
    event: 'report',
    prompt: 'Report to the parent that the task is done.',
    expect: /reported done/,
    pi: [{ tool: { name: 'parent_report', input: { status: 'done', text: 'the report event reached the parent' } } }, { text: 'reported' }],
    // Claude Code defers MCP tool schemas, so the child fetches the tool with
    // ToolSearch before it can call parent_report.
    claude: [
      { tool: { name: 'ToolSearch', input: { query: 'select:mcp__plugin_bellwether_bellwether__parent_report', max_results: 5 } } },
      { tool: { name: 'mcp__plugin_bellwether_bellwether__parent_report', input: { status: 'done', text: 'the report event reached the parent' } } },
      { text: 'reported' },
    ],
    idleMs: 60_000,
    blockedMs: 60_000,
    stuckMs: 60_000,
  },
  {
    event: 'idle',
    prompt: 'Say the idle event text and stop.',
    expect: /idle event text from the child/,
    // The turn has to outlast the parent's subscribe, or the parent first sees
    // the child already idle and the classifier has no transition to settle.
    pi: [{ text: 'idle event text from the child', delayMs: 9_000 }],
    claude: [{ text: 'idle event text from the child', delayMs: 9_000 }],
    idleMs: 1_000,
    blockedMs: 60_000,
    stuckMs: 60_000,
  },
  {
    event: 'blocked',
    prompt: 'Open the lab dialog and wait.',
    expect: /blocked on a dialog/,
    pi: [{ tool: { name: 'lab_block', input: {} } }, { text: 'dialog closed' }],
    claude: [{ tool: { name: 'Bash', input: { command: 'echo lab blocked' } } }, { text: 'dialog closed' }],
    piBlocked: true,
    claudePermissionMode: 'manual',
    idleMs: 60_000,
    blockedMs: 1_000,
    stuckMs: 60_000,
  },
  {
    event: 'stuck',
    prompt: 'Start a turn that never finishes.',
    expect: /has been quiet/,
    pi: [{ stall: true }],
    claude: [{ stall: true }],
    idleMs: 60_000,
    blockedMs: 60_000,
    stuckMs: 3_000,
  },
  {
    event: 'exited',
    prompt: 'Say the exited event text and stop.',
    expect: /exited/,
    pi: [{ text: 'exited event text from the child' }],
    claude: [{ text: 'exited event text from the child' }],
    idleMs: 60_000,
    blockedMs: 60_000,
    stuckMs: 60_000,
  },
];

/** The lab's blocked-event producer for a Pi child. */
function writeBlockExtension(dir: string): string {
  const file = path.join(dir, 'extensions', 'lab-block.ts');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `// The lab's blocked-event producer. It tells herdr's integration the agent\n// is waiting on a dialog, then opens a real Pi confirmation dialog.\nexport default function labBlock(pi: any): void {\n  pi.registerTool({\n    name: 'lab_block',\n    label: 'lab block',\n    description: 'Open a confirmation dialog for the lab blocked event.',\n    parameters: { type: 'object', properties: {} },\n    async execute(_id: string, _params: unknown, _signal: unknown, _onUpdate: unknown, ctx: any) {\n      try { pi.events.emit('herdr:blocked', { active: true, label: 'the lab dialog' }); } catch {}\n      let ok = false;\n      try {\n        ok = await ctx.ui.confirm('Lab blocked event', 'This dialog produces the blocked event.');\n      } finally {\n        try { pi.events.emit('herdr:blocked', { active: false }); } catch {}\n      }\n      return { content: [{ type: 'text', text: ok ? 'confirmed' : 'declined' }], details: undefined };\n    },\n  });\n}\n`,
  );
  return file;
}

interface StartedChild {
  child: ChildRecord;
  /** Close the child's tab or pane. */
  close(): Promise<void>;
}

/** Start a Pi child through the Bellwether spawn path, the way a parent does. */
async function startPiChild(options: { client: HerdrClient; lab: Lab; parent: ParentRecord; models: ScriptedModels; bellwetherHome: string; baseAgentDir: string; event: EventCase }): Promise<StartedChild> {
  const { client, lab, parent, models, bellwetherHome, baseAgentDir, event } = options;
  const childDir = path.join(lab.root, `pi-child-${event.event}-${Date.now()}`);
  const extensionFile = event.piBlocked ? writeBlockExtension(childDir) : undefined;
  await createPiAgentDir({ lab, dir: childDir, scriptedUrl: models.url, extraExtensions: extensionFile ? [extensionFile] : undefined, baseAgentDir });

  const previousEnv = process.env['PI_CODING_AGENT_DIR'];
  process.env['PI_CODING_AGENT_DIR'] = childDir;
  let child: ChildRecord;
  try {
    const result = await spawnChild(client, parent, {
      kind: 'pi',
      name: `child-${event.event}-${Date.now()}`,
      cwd: lab.root,
      prompt: event.prompt,
      env: { PI_CODING_AGENT_DIR: childDir, BELLWETHER_HOME: bellwetherHome },
      idleMs: event.idleMs,
      blockedMs: event.blockedMs,
      stuckMs: event.stuckMs,
    });
    child = result.child;
  } finally {
    if (previousEnv === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = previousEnv;
  }

  // spawnChild resolves the transcript a moment after the start, and Pi writes
  // its session file when the first turn begins, so re-resolve it now.
  const transcript = newestJsonl(path.join(childDir, 'sessions'));
  if (transcript) updateChild(parent.id, child.id, (entry) => { entry.transcript = transcript; });
  const paneId = child.paneId;
  return {
    child: readParent(parent.id)?.children.find((entry) => entry.id === child.id) ?? child,
    async close(): Promise<void> {
      await client.paneClose(paneId).catch(() => undefined);
    },
  };
}

/** Start a Claude child in its own tab, with the Bellwether child variables set. */
async function startClaudeChild(options: { lab: Lab; parent: ParentRecord; models: ScriptedModels; bellwetherHome: string; event: EventCase }): Promise<StartedChild> {
  const { lab, parent, models, bellwetherHome, event } = options;
  const name = `claude-child-${event.event}`;
  const childId = newChildId();
  const now = new Date().toISOString();
  // 1. The record lands before herdr is asked for anything.
  upsertChild(parent.id, {
    id: childId,
    name,
    kind: 'claude',
    harness: 'claude-code',
    paneId: '',
    startedAt: now,
    lastStatus: 'unknown',
    statusChangedAt: now,
    lastBusyAt: now,
    depth: 1,
    idleMs: event.idleMs,
    blockedMs: event.blockedMs,
    stuckMs: event.stuckMs,
  });

  const handle = await startHarness({
    lab,
    kind: 'claude',
    label: name,
    scriptedUrl: models.url,
    bellwetherHome,
    cwd: lab.root,
    permissionMode: event.claudePermissionMode,
    prompt: event.prompt,
    extraEnv: {
      BELLWETHER_PARENT: parent.id,
      BELLWETHER_CHILD: childId,
      BELLWETHER_CHILD_NAME: name,
      BELLWETHER_DEPTH: '1',
      BELLWETHER_HARNESS: 'claude-code',
    },
  });
  const transcript = await handle.transcript();
  updateChild(parent.id, childId, (entry) => {
    entry.paneId = handle.paneId;
    entry.tabId = handle.tabId;
    if (transcript) entry.transcript = transcript;
  });
  const child = readParent(parent.id)?.children.find((entry) => entry.id === childId);
  if (!child) throw new Error('the Claude child record vanished from the parent registry');
  return { child, close: () => handle.close() };
}

interface RunEventOptions {
  client: HerdrClient;
  lab: Lab;
  parent: ParentRecord;
  parentHarness: LabHarness;
  parentModels: ScriptedModels;
  bellwetherHome: string;
  event: EventCase;
  childKind: LabHarnessKind;
}

/** Start one child for an event and wait for its receipt to be read. */
async function runEvent(options: RunEventOptions): Promise<void> {
  const { client, lab, parent, parentHarness, parentModels, bellwetherHome, event, childKind } = options;
  const models = await startScriptedModels();
  models.sequence(childKind === 'pi' ? event.pi : event.claude);
  const started = childKind === 'pi'
    ? await startPiChild({ client, lab, parent, models, bellwetherHome, baseAgentDir: parentHarness.agentDir, event })
    : await startClaudeChild({ lab, parent, models, bellwetherHome, event });
  const { child } = started;

  // The exited event needs the pane to go away first. Wait long enough for the
  // parent's watcher to have subscribed to the live child, then close it.
  if (event.event === 'exited') {
    const closeAt = Date.parse(child.startedAt) + 6_000;
    while (Date.now() < closeAt) await wait(200);
    await client.paneClose(child.paneId).catch(() => undefined);
  }

  const deadline = Date.now() + 60_000;
  let entry: OutboxEntry;
  for (;;) {
    // A child first seen already settled produces one idle event before its
    // turn, so match the text the case expects rather than the first idle.
    const candidate = Outbox.load(parent.id).all().find((item) => item.childId === child.id && item.event === event.event && item.read && event.expect.test(item.text));
    if (candidate) {
      entry = candidate;
      break;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for the ${event.event} receipt to be read`);
    await wait(300);
  }
  assert.match(entry.text, event.expect, `the ${event.event} message should describe the event`);

  const transcript = parentHarness.kind === 'pi' ? findTranscript(parentHarness.agentDir, parent.session) : await parentHarness.transcript();
  assert.ok(transcript, 'the parent transcript should exist');
  const transcriptDeadline = Date.now() + 30_000;
  while (Date.now() < transcriptDeadline && !receiptThenAssistant(transcript, entry.receipt)) await wait(300);
  assert.ok(receiptThenAssistant(transcript, entry.receipt), `the parent transcript should hold ${entry.receipt} followed by an assistant message`);
  assert.ok(parentModels.requests.some((request) => JSON.stringify(request.body ?? {}).includes(entry.receipt)), 'the parent model should have seen the receipt');

  // Wait for the parent's turn to finish before the next event starts.
  const idleDeadline = Date.now() + 15_000;
  while (Date.now() < idleDeadline) {
    const pane = (await client.agentList()).find((candidatePane) => candidatePane.paneId === parentHarness.paneId);
    if (!pane || pane.agentStatus === 'idle' || pane.agentStatus === 'done') break;
    await wait(300);
  }

  if (event.event === 'stuck') models.release();
  await started.close();
  await models.stop();
}

/** One lab and one parent harness, then five events with the given child kind. */
function pairTest(title: string, parentKind: LabHarnessKind, childKind: LabHarnessKind, skip: string | boolean): void {
  test(title, { skip, timeout: 330_000 }, async (t) => {
    const parentModels = await startScriptedModels({ text: 'parent ready' });
    const lab = await startLab();
    const bellwetherHome = path.join(lab.root, 'bellwether');
    fs.mkdirSync(bellwetherHome, { recursive: true });
    const previousHome = process.env['BELLWETHER_HOME'];
    process.env['BELLWETHER_HOME'] = bellwetherHome;
    let parentHarness: LabHarness | undefined;
    try {
      const harness = await startHarness({ lab, kind: parentKind, label: `${parentKind}-parent`, scriptedUrl: parentModels.url, bellwetherHome, cwd: lab.root });
      parentHarness = harness;
      const parent = await until('the parent registry', 60_000, () => listParents().find((candidate) => candidate.paneId === harness.paneId));
      // A Pi session starts at the first prompt, so prompt once herdr has the
      // agent, then wait for the transcript that prompt creates.
      if (parentKind === 'pi') await harness.client.agentPrompt(harness.paneId, 'You are the parent. Wait for child events.');
      await until('the parent transcript', 40_000, async () => (parentKind === 'pi' ? findTranscript(harness.agentDir, parent.session) : await harness.transcript()));

      for (const event of cases) {
        await t.test(`${event.event} reaches the ${parentKind} parent`, { timeout: 90_000 }, async () => {
          await runEvent({ client: harness.client, lab, parent: readParent(parent.id) ?? parent, parentHarness: harness, parentModels, bellwetherHome, event, childKind });
        });
      }
    } finally {
      await parentHarness?.close();
      await parentModels.stop();
      await lab.stop();
      if (previousHome === undefined) delete process.env['BELLWETHER_HOME'];
      else process.env['BELLWETHER_HOME'] = previousHome;
    }
  });
}

pairTest('the pi parent and pi child pair drives all five events', 'pi', 'pi', herdrMissing || piMissing);
pairTest('the pi parent and claude child pair drives all five events', 'pi', 'claude', herdrMissing || piMissing || claudeMissing);
pairTest('the claude parent and pi child pair drives all five events', 'claude', 'pi', herdrMissing || piMissing || claudeMissing || claudeChannelsReason);
pairTest('the claude parent and claude child pair drives all five events', 'claude', 'claude', herdrMissing || claudeMissing || claudeChannelsReason);
