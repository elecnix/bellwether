// Tier 2: adopting an agent on another machine (issue #118). Two machines are
// two Bellwether homes in one temporary root, joined by the fake ssh, as in
// remote-report.test.ts. The child's machine has a herdr of its own, a fake
// one, which the parent's watcher reads as it reads a remote child it
// spawned. The parent's relay links ask the daemon on the child's machine,
// through `bellwether relay-bridge`, to record the adoption, and that daemon
// decides who already watches the pane.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { pickMachine, type MachineProfile } from '../../src/core/machine.ts';
import { emptyParent, readParent, saveParent, upsertChild } from '../../src/core/registry.ts';
import { claimPane } from '../../src/core/pane-claims.ts';
import { RELAY_SCHEMA, readRelayRecord, removeRelayRecord, saveRelayRecord } from '../../src/core/relay-records.ts';
import { reclaimRemote, remoteOps } from '../../src/core/remote.ts';
import type { ChildRecord, OutboxEntry } from '../../src/core/types.ts';
import { Watcher } from '../../src/core/watcher.ts';
import { DaemonClient } from '../../src/daemon/client.ts';
import type { ParentHello, RelayReport } from '../../src/daemon/protocol.ts';
import { RelayLinks, relayInbox } from '../../src/daemon/relay-links.ts';
import { runBellwetherTool, type ToolContext } from '../../src/integrations/tools.ts';
import { stopDaemonsUnder } from '../fixtures/daemons.ts';
import { startFakeHerdr, type FakeHerdr, type RecordedRequest } from '../fixtures/fake-herdr.ts';
import { installFakeSsh, type FakeSsh } from '../fixtures/fake-ssh.ts';
import { LIVE_HOME } from '../fixtures/isolation.ts';
import { paneReadAnswer } from '../fixtures/ghost-screens.ts';

const PARENT_ID = 'claude-code-the-parent';
const PANE = 'w1:p5';
const SESSION = 'sess-far-0001';
const LIMITS = { idleMs: 40, blockedMs: 20, stuckMs: 60_000 };

/** The agent in pane w1:p5 on child-box, plus an empty pane w1:p4 and a watched one w1:p6. */
class FarPane {
  status = 'idle';
  /** While true, the harness in w1:p5 has quit and its shell holds the pane. */
  gone = false;
  seq = 3;
  stateSeq = 1;
  fake!: FakeHerdr;
  respond = (request: RecordedRequest): { result: unknown } | { error: { code: string; message: string } } | undefined => {
    if (request.method === 'agent.get') return this.gone ? { error: { code: 'agent_not_found', message: 'no agent in pane w1:p5' } } : { result: { type: 'agent_info', agent: this.info() } };
    if (request.method === 'agent.list') return { result: { type: 'agent_list', agents: [...(this.gone ? [] : [this.info()]), this.info('w1:p6', 'watched', 'sess-other')] } };
    if (request.method === 'session.snapshot') return { result: { type: 'session_snapshot', snapshot: { panes: [], agents: this.gone ? [] : [this.info()] } } };
    if (request.method === 'pane.list') return { result: { type: 'pane_list', panes: [this.bare(PANE), this.bare('w1:p4'), this.bare('w1:p6')] } };
    if (request.method === 'pane.read') return { result: paneReadAnswer(request.params, 'far screen', PANE) };
    return undefined;
  };
  private bare(paneId: string): Record<string, unknown> {
    return { pane_id: paneId, workspace_id: 'w1', tab_id: `w1:t${paneId.slice(4)}`, terminal_id: `term-${paneId}`, agent_status: 'unknown' };
  }
  private info(paneId = PANE, name = 'first-mate', session = paneId === PANE ? this.session : SESSION): Record<string, unknown> {
    return { pane_id: paneId, workspace_id: 'w1', tab_id: 'w1:t1', terminal_id: `term-${paneId}`, agent: 'claude', name, agent_status: paneId === PANE ? this.status : 'idle', agent_session: { value: session }, completion_seq: this.seq, state_change_seq: this.stateSeq, cwd: '/far/work' };
  }
  /** The harness quits and leaves its shell in the pane: herdr releases the agent. */
  quit(): void {
    this.gone = true;
    this.fake.send({ event: 'pane_agent_detected', data: { pane_id: PANE, workspace_id: 'w1', released: true } });
  }
  /** The session herdr reports in w1:p5. */
  session = SESSION;
  /** A harness starts in the pane again, by default on the same session, and herdr detects it. */
  resume(session = SESSION): void {
    this.gone = false;
    this.session = session;
    this.seq += 1;
    this.fake.send({ event: 'pane_agent_detected', data: { ...this.info(), agent_status: 'idle' } });
  }
  /** herdr's status event on the child's machine. */
  set(status: string, endsTurn = false): void {
    if (endsTurn) this.seq += 1;
    this.status = status;
    this.stateSeq += 1;
    this.fake.send({ event: 'pane_agent_status_changed', data: { pane_id: PANE, workspace_id: 'w1', agent_status: status, completion_seq: this.seq, state_change_seq: this.stateSeq } });
  }
}

interface World {
  root: string;
  parentHome: string;
  childHome: string;
  ssh: FakeSsh;
  far: FakeHerdr;
  pane: FarPane;
  links: RelayLinks;
  watcher: Watcher;
  ctx: ToolContext;
  /** While true, the parent cannot reach the herdr on child-box, as when the SSH link is down. */
  setDown(down: boolean): void;
  /** Move the watcher's clock forward, as a long outage would. */
  advance(ms: number): void;
  published: OutboxEntry[];
  logs: string[];
}

function inHome<T>(home: string, fn: () => T): T {
  const previous = process.env['BELLWETHER_HOME'];
  process.env['BELLWETHER_HOME'] = home;
  try {
    return fn();
  } finally {
    process.env['BELLWETHER_HOME'] = previous;
  }
}

const profiles: MachineProfile[] = [{ id: 'child-box', label: 'child-box', target: 'child-box', session: 'default', enabled: true }];
const resolve = async (label: string): Promise<MachineProfile> => pickMachine(profiles, label);

async function world(t: test.TestContext, options: { farDaemon?: (socketPath: string) => Promise<() => Promise<void>>; accept?: (host: string, report: RelayReport) => { refused?: string } } = {}): Promise<World> {
  // Under /tmp, because macOS caps a Unix socket path at 104 bytes.
  const root = fs.mkdtempSync('/tmp/bw-adopt-');
  assert.ok(!root.startsWith(LIVE_HOME));
  const parentHome = path.join(root, 'parent', '.bellwether');
  const childHome = path.join(root, 'child', '.bellwether');
  for (const home of [childHome, parentHome]) fs.mkdirSync(home, { recursive: true });
  const ssh = installFakeSsh(t, root, { 'child-box': { home: childHome, userHome: path.dirname(childHome) } });
  const saved = { home: process.env['BELLWETHER_HOME'], socket: process.env['BELLWETHER_DAEMON_SOCKET'] };
  process.env['BELLWETHER_HOME'] = parentHome;
  process.env['BELLWETHER_DAEMON_SOCKET'] = path.join(parentHome, 'daemon.sock');
  const stopFar = options.farDaemon ? await options.farDaemon(path.join(childHome, 'daemon.sock')) : undefined;

  const pane = new FarPane();
  const far = await startFakeHerdr({ respond: pane.respond });
  pane.fake = far;
  const near = await startFakeHerdr();
  let down = false;
  // The herdr bridge to child-box: a connection that fails while the link is down.
  const farClient = new HerdrClient({
    label: 'machine:child-box',
    dial: (onReady) => {
      const socket = net.createConnection(down ? path.join(root, 'no-such-herdr.sock') : far.socketPath);
      socket.on('connect', onReady);
      return socket;
    },
  });
  const nearClient = new HerdrClient({ socketPath: near.socketPath });
  const clientFor = async (host: string): Promise<HerdrClient> => {
    if (host === 'local') return nearClient;
    await resolve(host);
    return farClient;
  };

  const logs: string[] = [];
  const links = new RelayLinks({ resolve, initialDelayMs: 50, maxDelayMs: 200, readTimeoutMs: 10_000, heartbeatMs: 1_000, log: (line) => logs.push(line) });
  links.start(options.accept ?? (() => ({ refused: 'this case carries no reports' })));
  saveParent(emptyParent('claude-code', 'the-parent', '/work', { paneId: 'w1:p1' }));
  const published: OutboxEntry[] = [];
  let skew = 0;
  const remote = remoteOps(resolve, {}, links);
  const watcher = new Watcher({
    now: () => Date.now() + skew,
    client: nearClient,
    clientFor,
    parentId: PARENT_ID,
    limits: LIMITS,
    tickMs: 15,
    screenPollMs: 0,
    relayState: (host) => links.state(host),
    cleanupRemote: (record) => remote.cleanup(record),
    reclaimRemote: (record) => reclaimRemote(remote, PARENT_ID, record),
    childrenChanged: () => links.sync(),
    log: (line) => logs.push(`watcher: ${line}`),
    onEntries: (entries) => {
      for (const entry of entries) if (!entry.read && !published.some((seen) => seen.receipt === entry.receipt)) published.push(entry);
    },
  });
  watcher.start();
  const ctx: ToolContext = { client: nearClient, clientFor, parentId: PARENT_ID, watcher, remote, relayState: (host) => links.state(host) };

  t.after(async () => {
    watcher.stop();
    links.stop();
    await ssh.drop();
    await stopFar?.();
    await stopDaemonsUnder(root, childHome);
    await far.stop();
    await near.stop();
    process.env['BELLWETHER_HOME'] = saved.home;
    process.env['BELLWETHER_DAEMON_SOCKET'] = saved.socket;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    parentHome,
    childHome,
    ssh,
    far,
    pane,
    links,
    watcher,
    ctx,
    published,
    logs,
    advance(ms) {
      skew += ms;
    },
    setDown(value) {
      down = value;
      if (value) far.hangUp();
    },
  };
}

async function until(what: string, check: () => boolean, timeoutMs = 20_000, state?: () => unknown): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${state ? `; last seen: ${JSON.stringify(state())}` : ''}`);
    await delay(20);
  }
}

function child(w: World): ChildRecord | undefined {
  return readParent(PARENT_ID)?.children.find((entry) => entry.paneId === PANE);
}

/** Whether the watcher subscribed to the pane's status on child-box. */
function subscribed(w: World): boolean {
  return w.far.requests.some((request) => request.method === 'events.subscribe' && JSON.stringify(request.params).includes(PANE));
}

function subscriptions(w: World): number {
  return w.far.requests.filter((request) => request.method === 'events.subscribe' && JSON.stringify(request.params).includes(PANE)).length;
}

/** agent_adopt, followed by the sync the daemon runs after every call, which keeps the relay open for the new child. */
async function adopt(w: World, args: Record<string, unknown> = { target: `child-box:${PANE}` }): Promise<string> {
  try {
    return await runBellwetherTool(w.ctx, 'agent_adopt', args);
  } finally {
    w.links.sync();
  }
}

function listRow(text: string): string {
  return text.split('\n').find((line) => line.includes(PANE)) ?? '';
}

test('a pane on another machine is adopted, its record names that machine and its session, and its status changes reach the parent', async (t) => {
  const w = await world(t);
  const text = await adopt(w);
  assert.match(text, /Adopted first-mate, a claude agent on machine child-box in pane w1:p5, as child \S+\. Bellwether watches it from now on\. Its harness session is sess-far-0001\./);
  assert.match(text, /Its session holds no Bellwether server or extension connected to the daemon on machine child-box, so it cannot call parent_report\./);

  const record = child(w);
  assert.ok(record, 'the parent holds the child');
  assert.equal(record.host, 'child-box');
  assert.equal(record.paneId, PANE);
  assert.equal(record.origin, 'adopt');
  assert.deepEqual(record.session, { kind: 'id', value: SESSION }, 'the session id comes from the far herdr');
  assert.equal(record.transcript, undefined, "a remote child's transcript stays on its own machine");

  // The child's machine records the adoption, so it can say who watches the pane.
  const claim = inHome(w.childHome, () => readRelayRecord(record.id));
  assert.equal(claim?.adopted, true);
  assert.equal(claim?.paneId, PANE);
  assert.equal(claim?.parentId, PARENT_ID);
  assert.equal(claim?.session, SESSION);
  assert.deepEqual(w.ssh.remoteCalls().map((call) => call.argv[0]), ['relay-bridge'], 'the claim went over the relay connection, not a command of its own');

  await until('the watcher to subscribe on child-box', () => subscribed(w));
  w.pane.set('working');
  w.pane.set('idle', true);
  await until('the idle event from child-box', () => w.published.some((entry) => entry.childId === record.id && entry.event === 'idle'), 5_000, () => w.published);

  // Adopting it again is the same child, and the far machine agrees.
  assert.match(await adopt(w, { target: PANE, machine: 'child-box' }), /already a child of this session/);
});

test('an adopted session on another machine whose Bellwether adapter is already connected there gains parent_report, and its report reaches the adopter over the relay', async (t) => {
  const reports: { host: string; report: RelayReport }[] = [];
  const w = await world(t, { accept: (host, report) => (reports.push({ host, report }), {}) });
  // The session in w1:p5 on child-box loaded Bellwether at its start, from a plugin or pi's package: its adapter said hello there with its pane and its own session, and no child id.
  const far = await DaemonClient.connect({ harness: 'claude-code', session: SESSION, cwd: '/far/work', host: 'child-box', paneId: PANE, depth: 0, herdrSocket: path.join(w.root, 'far-herdr.sock'), accepts: ['tools'] }, { home: w.childHome, socketPath: path.join(w.childHome, 'daemon.sock') });
  t.after(() => far.close());
  const changed: string[][] = [];
  far.onTools((tools) => changed.push(tools.map((tool) => tool.name)));
  assert.ok(!far.tools().some((tool) => tool.name === 'parent_report'), 'before the adoption, the session reports to nobody');

  const text = await adopt(w);
  assert.match(text, /Its session holds a Bellwether server or extension, connected to the daemon on machine child-box, which now offers it parent_report: a report from it reaches this session\./, text);
  await until('the far session to gain parent_report', () => far.tools().some((tool) => tool.name === 'parent_report'));
  assert.ok(changed.some((names) => names.includes('parent_report')), 'the adapter heard the tool list change, as Claude Code and pi do');

  const id = child(w)!.id;
  await until('the relay to hold child-box open for the child', () => w.links.state('child-box')?.status === 'connected' && (w.links.state('child-box')?.children ?? []).includes(id));
  const answer = await far.tool('parent_report', { status: 'done', text: 'Rebased and pushed.' });
  assert.equal(answer, 'Reported done to the parent on another machine, as first-mate.');
  await until('the report to cross the relay', () => reports.length > 0, 10_000, () => w.logs.slice(-5));
  assert.equal(reports[0]?.host, 'child-box');
  assert.equal(reports[0]?.report.childId, id, 'the report stands under the child id the adoption gave it');
  assert.equal(reports[0]?.report.parentId, PARENT_ID);
  assert.equal(reports[0]?.report.text, 'Rebased and pushed.');
});

test('a message to an adopted session on another machine enters that session over the relay, and the adoption promised it (issue #168)', async (t) => {
  const w = await world(t, { accept: () => ({}) });
  // A pi session there loaded Bellwether 0.1.8 from pi's settings: its extension takes messages in any session.
  const far = await DaemonClient.connect({ harness: 'pi', session: SESSION, cwd: '/far/work', host: 'child-box', paneId: PANE, depth: 0, herdrSocket: path.join(w.root, 'far-herdr.sock'), accepts: ['message', 'tools'] }, { home: w.childHome, socketPath: path.join(w.childHome, 'daemon.sock') });
  t.after(() => far.close());
  const taken: string[] = [];
  far.onMessage((message) => {
    taken.push(message.text);
    far.messageAck(message.id, 'queued', { via: 'pi-message' });
  });

  const text = await adopt(w);
  assert.match(text, /which now offers it parent_report: a report from it reaches this session, and a message from agent_send enters its session\./, text);
  const id = child(w)!.id;
  await until('the relay to hold child-box open for the child', () => w.links.state('child-box')?.status === 'connected' && (w.links.state('child-box')?.children ?? []).includes(id));
  const answer = await w.links.message('child-box', PARENT_ID, id, { id: 'm-0000a168', from: 'your parent', text: 'Rebase onto main before you push.', at: new Date().toISOString() });
  assert.deepEqual(answer, { delivered: true, via: 'pi-message' });
  assert.deepEqual(taken, ['Rebase onto main before you push.']);
});

/** What herdr on child-box was asked to type into the adopted pane. */
function typedFar(w: World): string[] {
  return w.far.requests.filter((request) => request.method === 'agent.prompt' && request.params['target'] === PANE).map((request) => String(request.params['text']));
}

/** The hello of a Claude Code server in the adopted pane on child-box that Claude Code loaded as a channel, with no child id. */
function farClaude(w: World, session: string): ParentHello {
  return { harness: 'claude-code', session, cwd: '/far/work', host: 'child-box', paneId: PANE, depth: 0, herdrSocket: path.join(w.root, 'far-herdr.sock'), accepts: ['message', 'tools'] };
}

/** Take each message as the channel server does, and answer that the session holds it. */
function takeMessages(client: DaemonClient, taken: string[]): void {
  client.onMessage((message, replay) => {
    taken.push(`${replay ? 'replay: ' : ''}${message.text}`);
    client.messageAck(message.id, 'queued', { via: 'claude-channel' });
  });
}

test('an adopted Claude Code session on another machine whose server started under a session it then left gains parent_report and messages once it names the adopted one, and keeps both across a restart of its harness (issue #184)', async (t) => {
  const w = await world(t, { accept: () => ({}) });
  w.ctx.inbox = (parentId, record, message, options) => relayInbox(w.links, parentId, record, message, options);
  const farHome = { home: w.childHome, socketPath: path.join(w.childHome, 'daemon.sock') };
  // Claude Code started its servers before the resume picker chose the session, so the server's first hello named the fresh session it started under, before any claim.
  const first = await DaemonClient.connect(farClaude(w, 'fresh-at-start-0002'), farHome);
  t.after(() => first.close());
  const taken: string[] = [];
  takeMessages(first, taken);

  await adopt(w);
  const id = child(w)!.id;
  assert.ok(!first.tools().some((tool) => tool.name === 'parent_report'), 'a session that names another session is not the adopted one');

  // The server reads the session Claude Code shows now and says hello as that session.
  await first.reidentify(SESSION);
  await until('the far session to gain parent_report', () => first.tools().some((tool) => tool.name === 'parent_report'));
  await until('the relay to hold child-box open for the child', () => w.links.state('child-box')?.status === 'connected' && (w.links.state('child-box')?.children ?? []).includes(id));
  const reply = await runBellwetherTool(w.ctx, 'agent_send', { child: id, text: 'Rebase onto main.' });
  assert.match(reply, /^Delivered to first-mate's session as message m-[0-9a-f]{8}, through its Bellwether channel; nothing was typed into its pane\./, reply);
  assert.deepEqual(taken, ['Rebase onto main.']);

  // The harness exits and comes back under the same session id, as a --resume after a reboot does.
  await first.close();
  const second = await DaemonClient.connect(farClaude(w, SESSION), farHome);
  t.after(() => second.close());
  takeMessages(second, taken);
  assert.ok(second.tools().some((tool) => tool.name === 'parent_report'), 'the hello of the restarted harness offers parent_report');
  const again = await runBellwetherTool(w.ctx, 'agent_send', { child: id, text: 'Push when green.' });
  assert.match(again, /^Delivered to first-mate's session as message m-[0-9a-f]{8}, through its Bellwether channel/, again);
  assert.ok(taken.includes('Push when green.'), JSON.stringify(taken));
  const messages = child(w)?.messages ?? [];
  assert.deepEqual(messages.map((message) => [message.path, message.via]), [['session', 'claude-channel'], ['session', 'claude-channel']]);
  assert.deepEqual(typedFar(w), [], 'herdr typed nothing into the adopted pane');
});

test('a message to an adopted child on another machine whose claim is gone there, and whose session runs no adapter, gets the claim back and is typed, and the reply and the record say why (issues #184, #219)', async (t) => {
  const w = await world(t);
  w.ctx.inbox = (parentId, record, message, options) => relayInbox(w.links, parentId, record, message, options);
  await adopt(w);
  const id = child(w)!.id;
  inHome(w.childHome, () => removeRelayRecord(id));
  await until('the relay to hold child-box open for the child', () => w.links.state('child-box')?.status === 'connected' && (w.links.state('child-box')?.children ?? []).includes(id));

  const reply = await runBellwetherTool(w.ctx, 'agent_send', { child: id, text: 'Status?' });
  const why = 'machine child-box answered: first-mate is an adopted session with no Bellwether server or extension connected to this machine\'s daemon, so nothing in it can take a message';
  const restored = `Machine child-box had lost its record of child ${id}, so Bellwether claimed pane ${PANE} there again before sending`;
  assert.match(reply, /^Prompted first-mate: herdr typed message m-[0-9a-f]{8} into its pane, because /, reply);
  assert.ok(reply.endsWith(`because ${why}. ${restored}.`), reply);
  assert.deepEqual(typedFar(w), ['Status?']);
  const message = child(w)?.messages?.at(-1);
  assert.equal(message?.path, 'keystrokes');
  assert.equal(message?.reason, `${why}. ${restored}.`);
  assert.equal(inHome(w.childHome, () => readRelayRecord(id))?.parentId, PARENT_ID, 'child-box holds the claim again');
});

// Issue #219: the parent's record and the far daemon hold the same fact twice.
// When the far daemon has lost its claim, as after a reboot of that machine,
// the parent claims the pane there again rather than type into it.
test('a message to an adopted child whose claim the far machine lost claims the pane there again and enters its session, with nothing typed (issue #219)', async (t) => {
  const w = await world(t, { accept: () => ({}) });
  w.ctx.inbox = (parentId, record, message, options) => relayInbox(w.links, parentId, record, message, options);
  const farHome = { home: w.childHome, socketPath: path.join(w.childHome, 'daemon.sock') };
  const session = await DaemonClient.connect(farClaude(w, SESSION), farHome);
  t.after(() => session.close());
  const taken: string[] = [];
  takeMessages(session, taken);
  await adopt(w);
  const id = child(w)!.id;
  await until('the relay to hold child-box open for the child', () => w.links.state('child-box')?.status === 'connected' && (w.links.state('child-box')?.children ?? []).includes(id));
  // child-box loses the claim, while this parent's record still names the child.
  inHome(w.childHome, () => removeRelayRecord(id));

  const reply = await runBellwetherTool(w.ctx, 'agent_send', { child: id, text: 'Status?' });
  assert.match(reply, /^Delivered to first-mate's session as message m-[0-9a-f]{8}, through its Bellwether channel; nothing was typed into its pane\./, reply);
  assert.match(reply, new RegExp(`Machine child-box had lost its record of child ${id}, so Bellwether claimed pane ${PANE} there again before sending\\.`), reply);
  assert.deepEqual(taken, ['Status?']);
  assert.deepEqual(typedFar(w), [], 'herdr typed nothing into the adopted pane');
  assert.equal(inHome(w.childHome, () => readRelayRecord(id))?.parentId, PARENT_ID, 'child-box holds the claim again');
  assert.equal(child(w)?.farRecordLost, undefined);
});

test('adopting a pane this session already holds asks the far machine, and claims it there again when that machine lost the claim (issue #219)', async (t) => {
  const w = await world(t, { accept: () => ({}) });
  await adopt(w);
  const id = child(w)!.id;
  inHome(w.childHome, () => removeRelayRecord(id));

  const reply = await adopt(w);
  assert.match(reply, new RegExp(`^first-mate in pane ${PANE} is already a child of this session\\. Machine child-box had lost its record of it, and holds it again as child ${id}\\.`), reply);
  assert.equal(inHome(w.childHome, () => readRelayRecord(id))?.childId, id);
  // With both records in place, a second call changes nothing and says so plainly.
  assert.equal(await adopt(w), `first-mate in pane ${PANE} is already a child of this session.`);
});

test('a far machine that refuses to take the claim back leaves the message typed, and the record and its reason say the two machines disagree (issue #219)', async (t) => {
  const w = await world(t);
  w.ctx.inbox = (parentId, record, message, options) => relayInbox(w.links, parentId, record, message, options);
  await adopt(w);
  const id = child(w)!.id;
  await until('the relay to hold child-box open for the child', () => w.links.state('child-box')?.status === 'connected' && (w.links.state('child-box')?.children ?? []).includes(id));
  // child-box lost this parent's claim, and another parent there took the pane since.
  inHome(w.childHome, () => {
    removeRelayRecord(id);
    claimPane({ parentId: 'pi-another-parent', childId: 'other-child', name: 'other', kind: 'claude', paneId: PANE, session: SESSION });
  });

  const reply = await runBellwetherTool(w.ctx, 'agent_send', { child: id, text: 'Status?' });
  assert.match(reply, /^Prompted first-mate: herdr typed message m-[0-9a-f]{8} into its pane, because /, reply);
  assert.match(reply, new RegExp(`machine child-box holds no running child ${id} for parent ${PARENT_ID}, and refused to take the claim back: pane ${PANE} is already a child of pi-another-parent`), reply);
  assert.deepEqual(typedFar(w), ['Status?']);
  const lost = child(w)?.farRecordLost;
  assert.ok(lost, 'the record keeps the disagreement');
  assert.equal(lost?.host, 'child-box');
  assert.match(lost?.reason ?? '', /already a child of pi-another-parent/);
});

/** Every record this parent holds for the adopted pane, live or exited. */
function recordsOfPane(): ChildRecord[] {
  return readParent(PARENT_ID)?.children.filter((entry) => entry.paneId === PANE) ?? [];
}

test('an adopted child on another machine whose harness quits and resumes the same session in the same pane stays the same child: its claim comes back, its tools arrive and a message enters its session (issue #191)', async (t) => {
  const w = await world(t, { accept: () => ({}) });
  w.ctx.inbox = (parentId, record, message, options) => relayInbox(w.links, parentId, record, message, options);
  const farHome = { home: w.childHome, socketPath: path.join(w.childHome, 'daemon.sock') };
  await adopt(w);
  const id = child(w)!.id;
  await until('the watcher to subscribe on child-box', () => subscribed(w));
  const first = await DaemonClient.connect(farClaude(w, SESSION), farHome);
  t.after(() => first.close());
  await until('the far session to gain parent_report', () => first.tools().some((tool) => tool.name === 'parent_report'));

  // The person quits the harness, and the shell stays in the pane.
  await first.close();
  w.pane.quit();
  await until('the exit', () => child(w)?.exitedAt !== undefined, 10_000, () => w.logs.slice(-5));
  await until('the exit event', () => w.published.some((entry) => entry.childId === id && entry.event === 'exited'), 10_000);
  assert.match(w.published.find((entry) => entry.event === 'exited')?.text ?? '', /Bellwether keeps watching pane w1:p5, and a resume of the same session there is the same child again\./);
  await until('the claim to leave child-box', () => !inHome(w.childHome, () => readRelayRecord(id)), 10_000);

  // The same session comes back in the same pane.
  w.pane.resume();
  await until('the same child to be live again', () => child(w)?.exitedAt === undefined, 10_000, () => w.logs.slice(-5));
  assert.deepEqual(recordsOfPane().map((entry) => entry.id), [id], 'one record, under the child id the adoption gave it');
  await until('the claim on child-box under the same child id', () => inHome(w.childHome, () => readRelayRecord(id))?.adopted === true, 10_000, () => w.logs.slice(-5));

  const second = await DaemonClient.connect(farClaude(w, SESSION), farHome);
  t.after(() => second.close());
  const taken: string[] = [];
  takeMessages(second, taken);
  assert.ok(second.tools().some((tool) => tool.name === 'parent_report'), 'the resumed session offers parent_report from its first hello');
  await until('the relay to hold child-box open for the child', () => w.links.state('child-box')?.status === 'connected' && (w.links.state('child-box')?.children ?? []).includes(id));
  const reply = await runBellwetherTool(w.ctx, 'agent_send', { child: id, text: 'Pick up where you left off.' });
  assert.match(reply, /^Delivered to first-mate's session as message m-[0-9a-f]{8}, through its Bellwether channel/, reply);
  assert.deepEqual(taken, ['Pick up where you left off.']);
  assert.deepEqual(typedFar(w), []);
});

test('another session started in the pane of an adopted child that quit is another agent: the child stays exited and its claim stays gone (issue #191)', async (t) => {
  const w = await world(t);
  await adopt(w);
  const id = child(w)!.id;
  await until('the watcher to subscribe on child-box', () => subscribed(w));
  w.pane.quit();
  await until('the exit', () => child(w)?.exitedAt !== undefined, 10_000);
  await until('the claim to leave child-box', () => !inHome(w.childHome, () => readRelayRecord(id)), 10_000);

  w.pane.resume('sess-someone-else-0003');
  await until('the watcher to stop waiting for the pane', () => readParent(PARENT_ID)?.children.find((entry) => entry.id === id)?.awaitsResume === undefined, 10_000, () => w.logs.slice(-5));
  assert.ok(child(w)?.exitedAt, 'the adopted child stays exited');
  assert.equal(inHome(w.childHome, () => readRelayRecord(id)), undefined, 'no claim on child-box for the other session');
  assert.ok(w.logs.some((line) => line.includes('now runs session sess-someone-else-0003')), w.logs.slice(-5).join('\n'));
});

test('an adopted child on another machine whose pane starts another session exits, its claim leaves that machine, and a parent there then adopts the pane as its only watcher (issue #211)', async (t) => {
  const w = await world(t);
  await adopt(w);
  const id = child(w)!.id;
  await until('the watcher to subscribe on child-box', () => subscribed(w));

  // The harness in the pane starts another session without quitting, as /clear does.
  w.pane.resume('sess-two-0002');
  await until('the adopted child to exit', () => child(w)?.exitedAt !== undefined, 10_000, () => w.logs.slice(-5));
  assert.equal(child(w)?.session?.value, SESSION, 'the record still names the session the parent adopted');
  await until('the claim to leave child-box', () => !inHome(w.childHome, () => readRelayRecord(id)), 10_000, () => w.logs.slice(-5));

  // A parent on child-box adopts the pane through its own herdr.
  w.watcher.stop();
  const local = inHome(w.childHome, () => saveParent(emptyParent('pi', 'pane-parent', '/far', { paneId: 'w1:p2' })));
  const farClient = new HerdrClient({ socketPath: w.far.socketPath });
  const text = await inHomeAsync(w.childHome, () => runBellwetherTool({ client: farClient, clientFor: async () => farClient, parentId: local.id, watcher: new Watcher({ client: farClient, parentId: local.id, onEntries: () => {} }) }, 'agent_adopt', { target: PANE }));
  assert.match(text, /^Adopted first-mate/, text);
  const watchers = [
    ...(readParent(PARENT_ID)?.children ?? []).filter((entry) => entry.paneId === PANE && !entry.exitedAt).map(() => PARENT_ID),
    ...inHome(w.childHome, () => readParent(local.id)?.children ?? []).filter((entry) => entry.paneId === PANE && !entry.exitedAt).map(() => local.id),
  ];
  assert.deepEqual(watchers, [local.id], 'one parent watches the pane');
});

/** Run an async call with another Bellwether home current. */
async function inHomeAsync<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env['BELLWETHER_HOME'];
  process.env['BELLWETHER_HOME'] = home;
  try {
    return await fn();
  } finally {
    process.env['BELLWETHER_HOME'] = previous;
  }
}

test('adopting a pane again after its harness resumed the same session keeps the child id, and a far machine that holds the session under another id says which one it replaced (issue #191)', async (t) => {
  const w = await world(t);
  await adopt(w);
  const id = child(w)!.id;
  await until('the watcher to subscribe on child-box', () => subscribed(w));
  w.pane.quit();
  await until('the exit', () => child(w)?.exitedAt !== undefined, 10_000);
  await until('the claim to leave child-box', () => !inHome(w.childHome, () => readRelayRecord(id)), 10_000);
  // The parent's watcher misses the return, as when its daemon was down.
  w.watcher.stop();
  w.pane.resume();

  const again = await adopt(w);
  assert.match(again, new RegExp(`Adopted first-mate again, as the same child ${id}: its harness resumed session ${SESSION} in pane w1:p5\\.`), again);
  assert.deepEqual(recordsOfPane().map((entry) => [entry.id, entry.exitedAt]), [[id, undefined]]);
  assert.equal(inHome(w.childHome, () => readRelayRecord(id))?.adopted, true);

  // Later the harness quits again, and child-box's state now holds the session under an id of its own.
  updateExited(id);
  inHome(w.childHome, () => {
    removeRelayRecord(id);
    saveRelayRecord({ schema: RELAY_SCHEMA, childId: 'c0ffee0000000191', name: 'first-mate', kind: 'claude', parentId: PARENT_ID, registeredAt: new Date().toISOString(), paneId: PANE, adopted: true, session: SESSION });
  });
  const replaced = await adopt(w);
  assert.match(replaced, new RegExp(`Machine child-box holds session ${SESSION} in pane w1:p5 as child c0ffee0000000191, so that child id replaces ${id}, which stays exited\\.`), replaced);
  const records = recordsOfPane();
  assert.deepEqual(records.map((entry) => entry.id).sort(), [id, 'c0ffee0000000191'].sort());
  assert.equal(records.find((entry) => entry.id === id)?.replacedBy, 'c0ffee0000000191');
  assert.equal(records.find((entry) => entry.id === 'c0ffee0000000191')?.exitedAt, undefined);
});

/** Mark the child exited on the parent's record, as an exit the watcher no longer sees would leave it. */
function updateExited(id: string): void {
  const record = readParent(PARENT_ID)!;
  const found = record.children.find((entry) => entry.id === id)!;
  upsertChild(PARENT_ID, { ...found, exitedAt: new Date().toISOString(), harnessEnded: 'in-pane' });
}

test('a session in an adopted pane on another machine whose harness session is not the adopted one gains nothing, and its report is refused there', async (t) => {
  const w = await world(t);
  const far = await DaemonClient.connect({ harness: 'pi', session: 'sess-later-0002', cwd: '/far/work', host: 'child-box', paneId: PANE, depth: 0, herdrSocket: path.join(w.root, 'far-herdr.sock'), accepts: ['tools'] }, { home: w.childHome, socketPath: path.join(w.childHome, 'daemon.sock') });
  t.after(() => far.close());
  assert.match(await adopt(w), /Its session holds no Bellwether server or extension connected to the daemon on machine child-box, so it cannot call parent_report\./);
  await delay(200);
  assert.ok(!far.tools().some((tool) => tool.name === 'parent_report'));
  await assert.rejects(far.tool('parent_report', { status: 'done', text: 'not mine to send' }), /parent_report has nobody to report to/);
});

test('an unknown machine, an empty pane and a pane another parent watches there are each refused by name', async (t) => {
  const w = await world(t);
  await assert.rejects(adopt(w, { target: 'nowhere:w1:p5' }), /Cannot adopt w1:p5 on machine nowhere: herdr has no saved machine nowhere\. Saved machines: child-box\./);
  await assert.rejects(adopt(w, { target: 'w1:p4', machine: 'child-box' }), /Pane w1:p4 on machine child-box holds no agent herdr recognizes/);
  await assert.rejects(adopt(w, { target: 'w1:p5', machine: 'elsewhere' }), /herdr has no saved machine elsewhere/);
  await assert.rejects(adopt(w, { target: 'child-box:w1:p5', machine: 'other-box' }), /names machine other-box, but its target child-box:w1:p5 names machine child-box/);

  // A parent on the child's machine itself watches w1:p6: only that machine's registry knows it.
  inHome(w.childHome, () => {
    saveParent(emptyParent('pi', 'far-parent', '/far', { paneId: 'w1:p2' }));
    const at = new Date().toISOString();
    upsertChild('pi-far-parent', { id: 'far-kid', name: 'watched', kind: 'claude', harness: 'claude-code', paneId: 'w1:p6', host: 'local', startedAt: at, lastStatus: 'idle', statusChangedAt: at, lastBusyAt: at, depth: 1 });
  });
  await assert.rejects(adopt(w, { target: 'child-box:w1:p6' }), /Pane w1:p6 on machine child-box cannot be adopted: pane w1:p6 is already a child of pi-far-parent, a parent on that machine, as watched\.$/);

  // A parent on a third machine adopted w1:p5 there earlier: its claim sits in that machine's relay records.
  inHome(w.childHome, () => saveRelayRecord({ schema: RELAY_SCHEMA, childId: 'third-kid', name: 'their-mate', kind: 'claude', parentId: 'claude-code-third-parent', registeredAt: new Date().toISOString(), paneId: PANE, adopted: true, session: SESSION }));
  await assert.rejects(adopt(w), /Pane w1:p5 on machine child-box cannot be adopted: pane w1:p5 is already a child of claude-code-third-parent, a parent on another machine, as their-mate\.$/);
  assert.equal(readParent(PARENT_ID)?.children.length, 0, 'no refusal left a child record behind');

  // A claim on the same pane id for another session is stale: herdr reused the id after that agent ended.
  inHome(w.childHome, () => saveRelayRecord({ schema: RELAY_SCHEMA, childId: 'third-kid', name: 'their-mate', kind: 'claude', parentId: 'claude-code-third-parent', registeredAt: new Date().toISOString(), paneId: PANE, adopted: true, session: 'sess-ended' }));
  assert.match(await adopt(w), /Adopted first-mate/);
  assert.equal(inHome(w.childHome, () => readRelayRecord('third-kid')), undefined, 'the stale claim is gone');
});

// RouteToWatcher in model/Claims.tla (issue #211, item 6): the far daemon saves the claim, and its answer is lost.
test('an adoption whose answer from the far machine is lost leaves a record in doubt, and the watcher asks again, so the claim there routes to a live child', async (t) => {
  const w = await world(t);
  // The far daemon receives the first adoption and saves its claim, and the link drops that one result line, so its
  // answer never comes back. A short bound against an answer that does come back would race the runner's speed.
  type Build = (id: string) => unknown;
  type Reply = { type: string; id?: string };
  const links = w.links as unknown as { ask: (host: string, type: string, build: Build, timeoutMs?: number) => Promise<string>; dispatch: (link: unknown, child: unknown, reply: Reply) => void };
  const ask = links.ask.bind(w.links);
  const dispatch = links.dispatch.bind(w.links);
  let lostId: string | undefined;
  links.ask = (host, type, build, timeoutMs) => {
    if (type !== 'relay-adopt' || lostId !== undefined) return ask(host, type, build, timeoutMs);
    return ask(host, type, (id) => ((lostId = id), build(id)), 200);
  };
  links.dispatch = (link, child, reply) => {
    if (reply.type === 'result' && reply.id !== undefined && reply.id === lostId) return;
    dispatch(link, child, reply);
  };
  const text = await adopt(w);
  assert.match(text, /^Machine child-box did not answer the adoption of pane w1:p5 \(machine child-box did not answer an adoption within 200 ms\), so Bellwether does not know whether it recorded it\. The child stands as first-mate, child \S+, in doubt: Bellwether asks that machine again and reports what it learns\./, text);
  const id = child(w)!.id;
  await until('the far claim', () => inHome(w.childHome, () => readRelayRecord(id))?.adopted === true, 10_000);
  await until('the doubt to clear', () => child(w)?.adoptInDoubt === undefined, 10_000, () => w.logs.slice(-5));
  await until('the watcher to subscribe on child-box', () => subscribed(w));
  const claim = inHome(w.childHome, () => readRelayRecord(id))!;
  const live = (readParent(PARENT_ID)?.children ?? []).filter((entry) => entry.id === claim.childId && !entry.exitedAt);
  assert.equal(live.length, 1, 'the parent the claim routes to watches a live child with that id');
  w.pane.set('working');
  w.pane.set('idle', true);
  await until('the idle event', () => w.published.some((entry) => entry.childId === id && entry.event === 'idle'), 5_000, () => w.published);
});

test('an adoption in doubt that the far machine refuses when asked again ends, and the exit event gives the refusal', async (t) => {
  const w = await world(t);
  inHome(w.childHome, () => saveRelayRecord({ schema: RELAY_SCHEMA, childId: 'c0ffee0000000211', name: 'theirs', kind: 'claude', parentId: 'claude-code-someone-else', registeredAt: new Date().toISOString(), paneId: PANE, adopted: true, session: SESSION }));
  const at = new Date().toISOString();
  w.watcher.stop();
  upsertChild(PARENT_ID, { id: 'feed000000000211', name: 'first-mate', kind: 'claude', harness: 'claude-code', paneId: PANE, tabId: 'w1:t1', workspaceId: 'w1', host: 'child-box', origin: 'adopt', cwd: '/far/work', startedAt: at, lastStatus: 'idle', statusChangedAt: at, lastBusyAt: at, depth: 1, session: { kind: 'id', value: SESSION }, adoptInDoubt: { at, host: 'child-box', reason: 'machine child-box did not answer an adoption within 1 ms' } });
  w.watcher.start();
  await until('the child to exit', () => child(w)?.exitedAt !== undefined, 10_000, () => w.logs.slice(-5));
  assert.equal(child(w)?.adoptInDoubt, undefined);
  await until('the exit event', () => w.published.some((entry) => entry.childId === 'feed000000000211' && entry.event === 'exited'), 5_000, () => w.published);
  const text = w.published.find((entry) => entry.event === 'exited')!.text;
  assert.match(text, /machine child-box refused the adoption Bellwether was not sure of: pane w1:p5 is already a child of claude-code-someone-else/, text);
  assert.equal(inHome(w.childHome, () => readRelayRecord('c0ffee0000000211'))?.parentId, 'claude-code-someone-else', 'the other claim stays');
});

test('a dropped link shows the child unreachable, not exited, and the reconnect restores it without a second adoption', async (t) => {
  const w = await world(t);
  // A stuck threshold of one minute, which the outage below runs far past.
  await adopt(w, { target: `child-box:${PANE}`, stuck_minutes: 1 });
  const id = child(w)!.id;
  await until('the watcher to subscribe on child-box', () => subscribed(w));
  w.pane.set('working');
  await until('the record to say working', () => child(w)?.lastStatus === 'working');
  const before = subscriptions(w);

  w.setDown(true);
  await until('the watcher to count child-box unreachable', () => w.watcher.unreachable('child-box') !== undefined, 5_000, () => w.logs.slice(-5));
  const listed = listRow(await runBellwetherTool(w.ctx, 'agent_list', {}));
  assert.match(listed, /\tunreachable since \S+ \(last seen working\)\t/, listed);
  assert.doesNotMatch(listed, /exited/);
  // Six minutes pass on the watcher's clock: past the stuck threshold and the five-minute inactivity period.
  w.advance(6 * 60_000);
  // The parent hears it through the inactivity notice, which says the child is unreachable rather than gone.
  await until('the inactivity notice', () => w.published.some((entry) => entry.childId === id && entry.event === 'inactive'), 5_000, () => w.published);
  assert.match(w.published.find((entry) => entry.event === 'inactive')?.text ?? '', /Bellwether cannot reach herdr on machine child-box since \S+ \(.+\), so that status is the last one it saw: the child is unreachable, not exited/);
  await delay(300);
  assert.equal(child(w)?.exitedAt, undefined, 'a dropped link is not an exit');
  assert.ok(!w.published.some((entry) => entry.event === 'exited' || entry.event === 'stuck'), `a quiet link is neither an exit nor a stall: ${JSON.stringify(w.published)}`);

  w.setDown(false);
  await until('the watcher to reach child-box again', () => w.watcher.unreachable('child-box') === undefined && subscriptions(w) > before, 20_000, () => w.logs.slice(-5));
  assert.doesNotMatch(listRow(await runBellwetherTool(w.ctx, 'agent_list', {})), /unreachable/);
  w.pane.set('working');
  w.pane.set('idle', true);
  await until('the idle event after the reconnect', () => w.published.some((entry) => entry.childId === id && entry.event === 'idle'), 5_000, () => w.published);
  assert.equal(readParent(PARENT_ID)?.children.length, 1, 'the same child, not a second adoption');
  assert.equal(child(w)?.id, id);
});

test('a restart of the daemon on the child machine is not the child exiting', async (t) => {
  const w = await world(t);
  await adopt(w);
  const id = child(w)!.id;
  await until('the relay to hold child-box open for the child', () => w.links.state('child-box')?.status === 'connected' && (w.links.state('child-box')?.children ?? []).includes(id));
  await until('the watcher to subscribe on child-box', () => subscribed(w));

  await stopDaemonsUnder(w.root, w.childHome);
  await until('the relay to notice the far daemon went', () => w.links.state('child-box')?.status === 'reconnecting', 10_000);
  await until('the relay to reconnect to a new far daemon', () => w.links.state('child-box')?.status === 'connected', 20_000, () => w.links.state('child-box'));
  assert.equal(child(w)?.exitedAt, undefined);
  assert.ok(!w.published.some((entry) => entry.event === 'exited'), JSON.stringify(w.published));

  // The new daemon there still knows who watches the pane, from the claim on disk.
  assert.match(await adopt(w), /already a child of this session/);
  w.pane.set('working');
  w.pane.set('idle', true);
  await until('the idle event after the far restart', () => w.published.some((entry) => entry.childId === id && entry.event === 'idle'), 5_000, () => w.published);
});

/**
 * A daemon from 0.1.5 on the child's machine: it serves the relay, and answers
 * a request it does not know the way 0.1.5's parser does.
 */
async function olderDaemon(socketPath: string): Promise<() => Promise<void>> {
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        const request = JSON.parse(line) as { type: string };
        if (request.type === 'relay-subscribe') {
          socket.write(`${JSON.stringify({ type: 'relay-hello', protocol: 4, pid: process.pid, waiting: 0, version: '0.1.5', build: '97d8f82' })}\n`);
          socket.write(`${JSON.stringify({ type: 'relay-drained', sent: 0 })}\n`);
        } else {
          socket.write(`${JSON.stringify({ type: 'error', code: 'unknown_type', message: `unknown request type ${JSON.stringify(request.type)}` })}\n`);
        }
      }
    });
  });
  await new Promise<void>((done) => server.listen(socketPath, done));
  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done) => server.close(() => done()));
  };
}

test('a machine whose Bellwether predates the request is refused with the version that brings it, and the relay stays up', async (t) => {
  const w = await world(t, { farDaemon: olderDaemon });
  await assert.rejects(adopt(w), /Pane w1:p5 on machine child-box cannot be adopted: machine child-box runs bellwether 0\.1\.5 build 97d8f82, which cannot adopt a pane for a parent on another machine: that takes the relay-adopt request, which came with bellwether 0\.1\.6\. Update @elecnix\/bellwether on machine child-box\.$/);
  assert.equal(readParent(PARENT_ID)?.children.length, 0);
  assert.notEqual(w.links.state('child-box')?.status, 'reconnecting', 'an unknown request does not end the relay');
});

// NoPaneTwoParentsCurrent and PaneOneLiveChildCurrent in model/Claims.tla (issue #244).
// Trace: a parent on another machine starts a child in pane x of the pane's machine (ResumeStart), then a parent there adopts x (LocalAdopt).
test('a child a parent on another machine started holds its pane on that machine while it runs there, so a parent there cannot adopt the pane as well', async (t) => {
  const w = await world(t);
  const at = new Date().toISOString();
  const cwd = path.join(w.root, 'work');
  fs.mkdirSync(cwd);
  const spawned: ChildRecord = { id: 'kid-spawned', name: 'far-worker', kind: 'claude', harness: 'claude-code', paneId: PANE, host: 'child-box', origin: 'spawn', cwd, startedAt: at, lastStatus: 'idle', statusChangedAt: at, lastBusyAt: at, depth: 1 };
  // The spawn: relay-register on child-box, run over the fake ssh as a real spawn runs it, then the child's own server says hello there from its pane.
  await w.ctx.remote!.register(readParent(PARENT_ID)!, spawned, 'Fix the build.');
  upsertChild(PARENT_ID, spawned);
  const session = await DaemonClient.connect({ harness: 'claude-code', session: SESSION, cwd, host: 'child-box', paneId: PANE, workspaceId: 'w1', depth: 1, childId: spawned.id, herdrSocket: w.far.socketPath, accepts: ['message'] }, { home: w.childHome, socketPath: path.join(w.childHome, 'daemon.sock') });
  t.after(() => session.close());

  // A pi session on child-box itself, in pane w1:p2, asks that machine's daemon to adopt the pane.
  const local = await DaemonClient.connect({ harness: 'pi', session: 'sess-pane-box-parent', cwd, host: 'child-box', paneId: 'w1:p2', workspaceId: 'w1', depth: 0, herdrSocket: w.far.socketPath }, { home: w.childHome, socketPath: path.join(w.childHome, 'daemon.sock') });
  t.after(() => local.close());
  await assert.rejects(
    local.tool('agent_adopt', { target: PANE }),
    new RegExp(`Pane ${PANE} on local cannot be adopted: pane ${PANE} is already a child of ${PARENT_ID}, a parent on another machine, as far-worker\\.`),
  );

  // The child's harness ends, and its parent's relay-cleanup never reaches child-box: its record stays there, and the pane is free.
  session.close();
  const deadline = Date.now() + 5_000;
  let text: string | undefined;
  while (text === undefined) {
    text = await local.tool('agent_adopt', { target: PANE }).catch((error: Error) => {
      if (Date.now() > deadline) throw error;
      return undefined;
    });
    if (text === undefined) await delay(20);
  }
  assert.match(text, /Adopted/, text);
  assert.ok(inHome(w.childHome, () => readRelayRecord(spawned.id)), 'the record relay-cleanup would remove is still there');
});
