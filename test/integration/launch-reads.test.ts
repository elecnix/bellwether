// Tier 2: issue #142. A Claude Code child stopped three times on questions
// Bellwether did not know, and each time a person had to press a key. The
// scripted pane here reads the child's launch the way Claude Code does: a
// read of the brief outside the working directory asks the read question
// unless the working directory, a directory in the launch settings or one in
// the machine's own settings holds it. The cases show the launch settings
// carrying the read set, so the question never comes, whatever the machine's
// own settings say; a question Bellwether knows answered No and recorded on
// the child; an adopted child left to its parent; and a question nobody knows
// failing the spawn by name, at once.
import { acquired } from '../../src/core/authority.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { promptPath } from '../../src/core/paths.ts';
import { emptyParent, readParent, saveParent, updateChild } from '../../src/core/registry.ts';
import { spawnChild } from '../../src/core/spawn.ts';
import { Watcher } from '../../src/core/watcher.ts';
import type { OutboxEntry, ParentRecord } from '../../src/core/types.ts';
import { harnessStart, startFakeHerdr, type FakeHerdr, type RecordedRequest } from '../fixtures/fake-herdr.ts';
import { CHANNEL_ACCEPT_SELECTED, CLAUDE_PROMPT, DANGEROUS_RM_QUESTION, OUTSIDE_READ_QUESTION, TRUST_NO_SELECTED, TRUST_YES_SELECTED, UNKNOWN_STARTUP_QUESTION } from '../fixtures/claude-screens.ts';
import { paneReadAnswer } from '../fixtures/ghost-screens.ts';

const PANE = 'w1:p1';
const SESSION = '7a1f00c2-5b8e-4c51-9d0e-1f2a3b4c5d6e';

/** A question with numbered options, whose selection moves with Up and Down. */
interface Choice {
  id: 'outside-read' | 'dangerous-rm' | 'unknown';
  text: string;
  selected: number;
}

const CHOICES: Record<Choice['id'], string> = { 'outside-read': OUTSIDE_READ_QUESTION, 'dangerous-rm': DANGEROUS_RM_QUESTION, unknown: UNKNOWN_STARTUP_QUESTION };

/** Draw a choice with the marker on option `selected`, counted from 0. */
function draw(choice: Choice): string {
  let n = -1;
  return choice.text
    .split('\n')
    .map((line) => {
      const option = /^ (?:❯|\s) (\d+\. .*)$/u.exec(line);
      if (!option) return line;
      n += 1;
      return ` ${n === choice.selected ? '❯' : ' '} ${option[1]}`;
    })
    .join('\n');
}

function options(choice: Choice): string[] {
  return choice.text
    .split('\n')
    .map((line) => /^ (?:❯|\s) \d+\. (.*)$/u.exec(line)?.[1])
    .filter((label): label is string => Boolean(label));
}

/** The settings files a Claude Code child merges: its --settings file and the machine's own. */
function allowedDirectories(launchArgs: readonly string[]): string[] {
  const dirs: string[] = [];
  const launch = launchArgs.find((arg) => arg.startsWith('--settings='))?.slice('--settings='.length);
  const local = path.join(process.env['CLAUDE_CONFIG_DIR'] ?? '', 'settings.json');
  for (const file of [launch, local]) {
    if (!file || !fs.existsSync(file)) continue;
    const settings = JSON.parse(fs.readFileSync(file, 'utf8')) as { permissions?: { additionalDirectories?: string[] } };
    dirs.push(...(settings.permissions?.additionalDirectories ?? []));
  }
  return dirs;
}

function inside(file: string, dir: string): boolean {
  const relative = path.relative(dir, file);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * One Claude Code pane through its startup questions and its first read. Once
 * the channel question is answered, the child reads the brief its launch
 * mentions: inside the working directory or an allowed directory it goes on
 * to the prompt, and anywhere else it asks the read question.
 */
class ClaudePane {
  screen: 'trust-no' | 'trust-yes' | 'channel' | 'prompt' | 'choice' = 'trust-no';
  choice: Choice | undefined;
  status = 'unknown';
  readonly keys: { key: string; on: string }[] = [];
  readonly seen = new Set<string>();
  /** What each answered choice chose. */
  readonly chosen: { id: Choice['id']; label: string }[] = [];
  launchArgs: string[] = [];
  cwd = '';
  fake!: FakeHerdr;

  constructor(first?: Choice['id']) {
    if (first) this.ask(first);
  }

  ask(id: Choice['id']): void {
    this.choice = { id, text: CHOICES[id], selected: 0 };
    this.screen = 'choice';
    this.seen.add(id);
  }

  text(): string {
    if (this.screen === 'choice' && this.choice) return draw(this.choice);
    return { 'trust-no': TRUST_NO_SELECTED, 'trust-yes': TRUST_YES_SELECTED, channel: CHANNEL_ACCEPT_SELECTED, prompt: CLAUDE_PROMPT, choice: '' }[this.screen];
  }

  /** Whether reading `file` asks the read question for this launch. */
  asksToRead(file: string): boolean {
    return !inside(file, this.cwd) && !allowedDirectories(this.launchArgs).some((dir) => inside(file, dir));
  }

  respond = (request: RecordedRequest): { result: unknown } | undefined => {
    if (request.method === 'tab.create') this.cwd = String(request.params['cwd'] ?? '');
    if (request.method === 'pane.read') return { result: paneReadAnswer(request.params, this.text(), PANE) };
    if (request.method === 'agent.get') return { result: { type: 'agent_info', agent: this.agentInfo() } };
    if (request.method === 'session.snapshot') return { result: { type: 'session_snapshot', snapshot: { panes: [], agents: [this.agentInfo()] } } };
    if (request.method === 'pane.list') return { result: { type: 'pane_list', panes: [{ pane_id: PANE }] } };
    const start = harnessStart(request);
    if (start) {
      // The pane answers its own start, so the fake's default reports of a
      // harness at its prompt never arrive. herdr detects the harness and
      // reports the status its screen shows before the start's reply, which
      // leaves no moment in which the two disagree (issue #183).
      this.launchArgs = start.args;
      this.fake.send({ event: 'pane_agent_detected', data: { pane_id: PANE, workspace_id: 'w1', agent: 'claude' } });
      this.settle();
      return { result: { type: 'ok' } };
    }
    if (request.method === 'agent.send_keys') {
      for (const key of request.params['keys'] as string[]) this.press(key);
      return { result: { type: 'ok' } };
    }
    return undefined;
  };

  private agentInfo(): Record<string, unknown> {
    const session = this.screen === 'prompt' ? { agent_session: { source: 'herdr:claude', agent: 'claude', kind: 'id', value: SESSION } } : {};
    return { pane_id: PANE, workspace_id: 'w1', tab_id: 'w1:t1', terminal_id: 'term_1', agent: 'claude', agent_status: this.status, ...session };
  }

  private press(key: string): void {
    this.keys.push({ key, on: this.screen === 'choice' ? (this.choice?.id ?? '') : this.screen });
    if (this.screen === 'trust-no' && key === 'Down') this.screen = 'trust-yes';
    else if (this.screen === 'trust-yes' && key === 'Enter') this.screen = 'channel';
    else if (this.screen === 'channel' && (key === 'Enter' || key === '1')) {
      // Claude Code attaches the brief the launch mentions, and reads it now.
      const brief = this.launchArgs.find((arg) => arg.startsWith('@'))?.slice(1);
      if (brief && this.asksToRead(brief)) this.ask('outside-read');
      else this.screen = 'prompt';
      this.settle();
    } else if (this.screen === 'choice' && this.choice) {
      const count = options(this.choice).length;
      if (key === 'Down') this.choice.selected = Math.min(count - 1, this.choice.selected + 1);
      else if (key === 'Up') this.choice.selected = Math.max(0, this.choice.selected - 1);
      else if (key === 'Enter' || /^\d$/.test(key)) {
        // A digit selects its option and confirms it, as Enter confirms the selected one.
        if (key !== 'Enter') this.choice.selected = Number(key) - 1;
        this.chosen.push({ id: this.choice.id, label: options(this.choice)[this.choice.selected] ?? '' });
        this.choice = undefined;
        this.screen = 'prompt';
        // A No ends the turn, and Claude Code waits at its prompt.
        this.settle();
      }
    }
  }

  /** Report the status the screen shows: idle at the prompt, blocked on any question. */
  private settle(): void {
    this.setStatus(this.screen === 'prompt' ? 'idle' : 'blocked');
  }

  setStatus(status: string): void {
    this.status = status;
    this.fake.send({ event: 'pane_agent_status_changed', data: { pane_id: PANE, workspace_id: 'w1', agent: 'claude', agent_status: status } });
  }
}

interface Rig {
  fake: FakeHerdr;
  client: HerdrClient;
  parent: ParentRecord;
  published: OutboxEntry[];
  worktree: string;
  stop(): Promise<void>;
}

async function rig(pane: ClaudePane): Promise<Rig> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-reads-'));
  // The child's working directory is a checkout of its own, apart from the home that holds its brief.
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-worktree-'));
  process.env['BELLWETHER_HOME'] = home;
  const fake = await startFakeHerdr({ respond: pane.respond });
  pane.fake = fake;
  const client = new HerdrClient({ socketPath: fake.socketPath });
  const parent = saveParent(emptyParent('claude-code', `s-${Math.random().toString(36).slice(2)}`, home, { workspaceId: 'w1' }));
  const published: OutboxEntry[] = [];
  const watcher = new Watcher({
    client,
    parentId: parent.id,
    limits: { idleMs: 30, blockedMs: 20, stuckMs: 60_000 },
    tickMs: 15,
    screenPollMs: 0,
    onEntries: (entries) => {
      for (const entry of entries) if (!entry.read && !published.some((seen) => seen.receipt === entry.receipt)) published.push(entry);
    },
  });
  watcher.start();
  return {
    fake,
    client,
    parent,
    published,
    worktree,
    async stop() {
      watcher.stop();
      await fake.stop();
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(worktree, { recursive: true, force: true });
    },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait for `done`, up to `ms`. The watcher answers at its own redraw pace, 300 ms a key. */
async function until(done: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) await sleep(20);
}

/** The machine's own Claude Code settings, as the operator left them. */
function machineSettings(settings: Record<string, unknown> | undefined): void {
  const dir = process.env['CLAUDE_CONFIG_DIR'] ?? '';
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'settings.json');
  if (settings) fs.writeFileSync(file, JSON.stringify(settings));
  else fs.rmSync(file, { force: true });
}

function launchSettings(pane: ClaudePane): { permissions: { additionalDirectories: string[] }; sandbox: { filesystem: { allowRead: string[] } } } {
  const file = pane.launchArgs.find((arg) => arg.startsWith('--settings='))?.slice('--settings='.length) ?? '';
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('a child whose brief lives outside its working directory never sees the read question, because its launch settings name the directory', async () => {
  machineSettings(undefined);
  const pane = new ClaudePane();
  const r = await rig(pane);
  try {
    const { child } = await spawnChild(r.client, r.parent, { kind: 'claude', name: 'kid', prompt: 'go', cwd: r.worktree, redrawMs: 10, startupTimeoutMs: 5_000 });
    const brief = promptPath(child.id);
    assert.ok(!inside(brief, r.worktree), 'the brief is outside the working directory');
    // The launch settings carry the directory that holds the brief, for the file tools and for sandboxed commands.
    const home = path.resolve(process.env['BELLWETHER_HOME'] ?? '');
    assert.deepEqual(launchSettings(pane).permissions.additionalDirectories, [home]);
    assert.deepEqual(launchSettings(pane).sandbox.filesystem.allowRead, [home]);
    // The child went from the channel question straight to its prompt.
    assert.equal(pane.screen, 'prompt');
    assert.ok(!pane.seen.has('outside-read'), 'the read question never came');
    assert.deepEqual(pane.keys.map(({ key }) => key), ['Down', 'Enter', '1']);
    // Without that entry, the same launch would have asked.
    pane.launchArgs = pane.launchArgs.filter((arg) => !arg.startsWith('--settings='));
    assert.equal(pane.asksToRead(brief), true);
    await sleep(150);
    assert.deepEqual(r.published.map((entry) => entry.event), []);
  } finally {
    await r.stop();
  }
});

test("the launch settings, not the machine's own file, decide what a child reads", async () => {
  // One machine has the reads relaxed in its own settings, and the other has
  // nothing. The same spawn on each gets the same launch read set, and
  // neither child asks.
  const relaxed = { permissions: { additionalDirectories: [os.tmpdir()] }, sandbox: { filesystem: { disabled: true } } };
  const launches: unknown[] = [];
  for (const settings of [relaxed, undefined]) {
    machineSettings(settings);
    const pane = new ClaudePane();
    const r = await rig(pane);
    try {
      const { child } = await spawnChild(r.client, r.parent, { kind: 'claude', name: 'kid', prompt: 'go', cwd: r.worktree, redrawMs: 10, startupTimeoutMs: 5_000 });
      assert.ok(!pane.seen.has('outside-read'), `the child asked to read its brief on the machine with ${settings ? 'relaxed' : 'no'} settings`);
      const launch = launchSettings(pane);
      // Only the launch names the brief's directory on the machine with no settings of its own.
      assert.ok(launch.permissions.additionalDirectories.some((dir) => inside(promptPath(child.id), dir)));
      const home = path.resolve(process.env['BELLWETHER_HOME'] ?? '');
      launches.push({ permissions: { additionalDirectories: launch.permissions.additionalDirectories.map((dir) => path.relative(home, dir)) }, sandbox: { filesystem: { allowRead: launch.sandbox.filesystem.allowRead.map((dir) => path.relative(home, dir)) } } });
    } finally {
      await r.stop();
      machineSettings(undefined);
    }
  }
  // The machine's settings changed nothing in what the launch carries.
  assert.equal(launches.length, 2);
  assert.deepEqual(launches[0], launches[1]);
});

test('a read question Bellwether knows is answered No, recorded on the child, and named in the parent\'s next event', async () => {
  machineSettings(undefined);
  const pane = new ClaudePane();
  const r = await rig(pane);
  try {
    const { child } = await spawnChild(r.client, r.parent, { kind: 'claude', name: 'kid', prompt: 'go', cwd: r.worktree, redrawMs: 10, startupTimeoutMs: 5_000 });
    pane.keys.length = 0;
    // The child reaches for a file in another checkout, beyond its read set.
    pane.ask('outside-read');
    pane.setStatus('blocked');
    await until(() => r.published.some((entry) => entry.event === 'idle'));

    // The digit of "No, and ask again next time", the answer that saves nothing.
    assert.deepEqual(pane.keys.map(({ key }) => key), ['3']);
    assert.deepEqual(pane.chosen, [{ id: 'outside-read', label: 'No, and ask again next time' }]);
    const record = readParent(r.parent.id)?.children.find((entry) => entry.id === child.id);
    assert.equal(record?.decisions?.length, 1);
    const decision = record?.decisions?.[0];
    assert.equal(decision?.dialog, 'outside-read');
    assert.equal(decision?.question, 'Allow this read outside the working directories?');
    assert.equal(decision?.answer, 'No, and ask again next time');
    assert.deepEqual(decision?.keys, ['3']);
    assert.equal(decision?.by, 'watcher');
    assert.match(decision?.decided ?? '', /declined the read/);
    // A refusal, told apart from an answered question, with the path the child asked for.
    assert.equal(decision?.outcome, 'declined');
    assert.equal(decision?.path, '/var/tmp/example-other-repo/eslint.config.js');

    // No blocked event: the parent hears what was decided, with the idle that followed.
    assert.deepEqual(r.published.filter((entry) => entry.event === 'blocked'), []);
    const idle = r.published.find((entry) => entry.event === 'idle');
    assert.match(idle?.text ?? '', /Bellwether declined kid \(w1:p1\)'s read of \/var\/tmp\/example-other-repo\/eslint\.config\.js: the question about a read outside the working directories, answered "No, and ask again next time" \(keys 3\)/);
    assert.match(idle?.text ?? '', /agent_restart with reads \["\/var\/tmp\/example-other-repo"\] keeps its session/);

    // The parent sends the same instruction, the child reaches for the same file, and meets the same No.
    const idles = r.published.filter((entry) => entry.event === 'idle').length;
    pane.ask('outside-read');
    pane.setStatus('blocked');
    await until(() => r.published.filter((entry) => entry.event === 'idle').length > idles);
    const again = r.published.filter((entry) => entry.event === 'idle').at(-1);
    assert.match(again?.text ?? '', /This is the second time Bellwether declined that path for it, so the brief needs it\./);
    assert.deepEqual(r.published.filter((entry) => entry.event === 'blocked'), [], 'no person is paged for either');
    assert.equal(readParent(r.parent.id)?.children.find((entry) => entry.id === child.id)?.decisions?.[0]?.told, true);
  } finally {
    await r.stop();
  }
});

test('a dangerous-rm question is answered No and recorded, and an adopted child\'s is left to its parent', async () => {
  machineSettings(undefined);
  const pane = new ClaudePane();
  const r = await rig(pane);
  try {
    const { child } = await spawnChild(r.client, r.parent, { kind: 'claude', name: 'kid', prompt: 'go', cwd: r.worktree, redrawMs: 10, startupTimeoutMs: 5_000 });
    pane.keys.length = 0;
    pane.ask('dangerous-rm');
    pane.setStatus('blocked');
    await until(() => pane.chosen.length > 0 && Boolean(readParent(r.parent.id)?.children[0]?.decisions?.length));
    assert.deepEqual(pane.chosen, [{ id: 'dangerous-rm', label: 'No, and tell Claude what to do differently (esc)' }]);
    const decision = readParent(r.parent.id)?.children.find((entry) => entry.id === child.id)?.decisions?.[0];
    assert.equal(decision?.dialog, 'dangerous-rm');
    assert.equal(decision?.question, 'Do you want to proceed?');

    // The same question in a pane Bellwether adopted is the parent's to answer.
    updateChild(r.parent.id, child.id, (entry) => Object.assign(entry, acquired('adopt')));
    pane.keys.length = 0;
    pane.ask('dangerous-rm');
    pane.setStatus('blocked');
    await until(() => r.published.some((entry) => entry.event === 'blocked'));
    assert.deepEqual(pane.keys, [], 'nothing typed into an adopted pane');
    const blocked = r.published.filter((entry) => entry.event === 'blocked');
    assert.equal(blocked.length, 1);
    assert.match(blocked[0]?.text ?? '', /Do you want to proceed\?/);
  } finally {
    await r.stop();
  }
});

test('a startup question nobody knows fails the spawn at once, and the failure quotes it', async () => {
  machineSettings(undefined);
  const pane = new ClaudePane('unknown');
  const r = await rig(pane);
  try {
    const started = Date.now();
    await assert.rejects(
      spawnChild(r.client, r.parent, { kind: 'claude', name: 'kid', prompt: 'go', cwd: r.worktree, redrawMs: 10, startupTimeoutMs: 5_000 }),
      (error: Error) => {
        assert.equal(error.name, 'StartupDialogUnknown');
        assert.match(error.message, /stopped on a question Bellwether does not know: "Import them into this session\?"/);
        assert.match(error.message, /the folder-trust question/);
        return true;
      },
    );
    // It did not wait out the five seconds for a person.
    assert.ok(Date.now() - started < 2_000, `the spawn failed after ${Date.now() - started} ms`);
    assert.deepEqual(pane.keys, [], 'no key went to a question nobody knows');
    assert.ok(r.fake.requests.some((request) => request.method === 'tab.close'));
    assert.deepEqual(readParent(r.parent.id)?.children, []);
  } finally {
    await r.stop();
  }
});

test('a spawn that names reads lets the child read there without a question, and a checkout it did not name still asks', async () => {
  machineSettings(undefined);
  const pane = new ClaudePane();
  const r = await rig(pane);
  try {
    // The brief says to copy a lint rule from another checkout.
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'example-other-checkout-'));
    const { child } = await spawnChild(r.client, r.parent, { kind: 'claude', name: 'kid', prompt: 'go', cwd: r.worktree, reads: [other], redrawMs: 10, startupTimeoutMs: 5_000 });
    assert.deepEqual(readParent(r.parent.id)?.children.find((entry) => entry.id === child.id)?.reads, [other]);
    assert.deepEqual(launchSettings(pane).permissions.additionalDirectories, [path.resolve(process.env['BELLWETHER_HOME'] ?? ''), other]);
    assert.equal(pane.asksToRead(path.join(other, 'eslint.config.js')), false, 'the rule the brief names reads without a question');
    assert.equal(pane.asksToRead('/var/tmp/example-other-repo/eslint.config.js'), true, 'a checkout the brief did not name still asks');
    fs.rmSync(other, { recursive: true, force: true });
  } finally {
    await r.stop();
  }
});
