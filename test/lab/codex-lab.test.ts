// Tier 3: the Codex drill, against a real Codex under a real herdr server of
// the lab's own. The spawn starts Codex in a lab pane, and herdr has to detect
// it as a codex agent. Codex has to find its folder trusted without a
// keystroke, and write the session's rollout with the brief's prompt, where
// the spawn finds it. The scripted Responses endpoint then has the model call
// parent_report through the Bellwether server the child's launch line
// defines: the report has to land in the parent's spool with the word only
// the brief holds. Last, agent_read has to return the child's answer from the
// rollout, without reading the screen. A second turn has the model call
// agent_list, which is not pre-approved: Codex has to refuse it under -a never.
//
// The model is the lab's scripted Responses endpoint, named in a config.toml
// in the lab's own Codex home, so the case makes no call outside this machine
// and needs no credentials. The lab's environment drops every variable whose
// name ends in _API_KEY or _AUTH_TOKEN before herdr starts, so the pane and
// Codex inherit none. It skips without herdr and without a codex on PATH, so
// CI stays green.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { codexLastMessage, rolloutMeta } from '../../src/core/harnesses/codex-store.ts';
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { spoolPath } from '../../src/core/paths.ts';
import { emptyParent, readParent, saveParent } from '../../src/core/registry.ts';
import { spawnChild } from '../../src/core/spawn.ts';
import { Watcher } from '../../src/core/watcher.ts';
import { runBellwetherTool } from '../../src/integrations/tools.ts';
import { daemonsUnder, stopDaemonsUnder } from '../fixtures/daemons.ts';
import { hasHerdr, startLab } from './herdr-lab.ts';
import { startScriptedModels } from './scripted-models.ts';

const run = promisify(execFile);

async function codexVersion(): Promise<string | undefined> {
  try {
    const { stdout } = await run('codex', ['--version'], { timeout: 15_000 });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

const version = await codexVersion();
const skip = !(await hasHerdr()) ? 'herdr is not on PATH' : version === undefined ? 'no codex on PATH' : false;

async function until<T>(probe: () => T | undefined | Promise<T | undefined>, what: string, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(250);
  }
}

interface SpoolEntry {
  childId?: string;
  status?: string;
  text?: string;
}

function spooled(parentId: string, childId: string): SpoolEntry | undefined {
  let content: string;
  try {
    content = fs.readFileSync(spoolPath(parentId), 'utf8');
  } catch {
    return undefined;
  }
  return content
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SpoolEntry)
    .find((entry) => entry.childId === childId);
}

test('the Codex drill: a real Codex gets its brief, reports to its parent through its own server, agent_read returns its answer, and an unlisted tool stays gated', { skip, timeout: 240_000 }, async (t) => {
  // The child's MCP server starts a daemon for the home its pane inherits, so
  // the case gets a home of its own, set before the lab herdr starts, and the
  // cleanup stops whatever daemon that server started there.
  const root = fs.mkdtempSync('/tmp/bw-cxl-');
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const codexHome = path.join(root, 'codex-home');
  fs.mkdirSync(codexHome, { recursive: true });
  const previous = { home: process.env['BELLWETHER_HOME'], socket: process.env['BELLWETHER_DAEMON_SOCKET'], codex: process.env['CODEX_HOME'] };
  process.env['BELLWETHER_HOME'] = home;
  process.env['BELLWETHER_DAEMON_SOCKET'] = path.join(home, 'daemon.sock');
  process.env['CODEX_HOME'] = codexHome;
  const word = 'heron';
  const models = await startScriptedModels({ tool: { name: 'parent_report', input: { status: 'done', text: `The drill word is ${word}.` } }, text: 'I reported it.' });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), `model = "example-model"\nmodel_provider = "example"\n\n[model_providers.example]\nname = "example"\nbase_url = "${models.url}/v1"\nwire_api = "responses"\n`);
  const lab = await startLab();
  const herdr = new HerdrClient({ socketPath: lab.socketPath });
  let paneId: string | undefined;
  t.after(async () => {
    if (paneId) await herdr.paneClose(paneId).catch(() => undefined);
    await lab.stop();
    await models.stop();
    await stopDaemonsUnder(root, home);
    for (const [key, value] of [['BELLWETHER_HOME', previous.home], ['BELLWETHER_DAEMON_SOCKET', previous.socket], ['CODEX_HOME', previous.codex]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
    assert.deepEqual(daemonsUnder(root), [], 'a daemon outlived the case');
  });

  // A git working tree, where Codex asks its folder-trust question on a first start.
  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  await run('git', ['init', '-q', cwd]);
  const created = (await herdr.request('workspace.create', { cwd, label: 'codex-lab', focus: false })) as { workspace?: { workspace_id?: string } };
  const workspaceId = created.workspace?.workspace_id;
  assert.ok(workspaceId, 'the lab created a workspace');
  const parentId = saveParent(emptyParent('claude-code', `codex-lab-${path.basename(root)}`, cwd, { workspaceId })).id;

  const prompt = `The drill word is ${word}. Call the parent_report tool with status done and the text "The drill word is ${word}."`;
  const { child } = await spawnChild(herdr, readParent(parentId)!, { kind: 'codex', name: 'cx-lab', prompt, cwd }, undefined, { harness: { store: codexHome, waitMs: 60_000 } }).catch(async (error: unknown) => {
    console.log(`models: ${JSON.stringify(models.requests.map((request) => request.path))}`);
    throw error;
  });
  paneId = child.paneId;
  console.log(`codex ${version}, session ${child.session?.value}`);

  // herdr detects Codex, and the session the spawn found is a rollout in the child's directory.
  const agent = (await herdr.request('agent.get', { target: child.paneId })) as { agent?: Record<string, unknown> };
  assert.equal(agent.agent?.['agent'], 'codex', `herdr detected ${String(agent.agent?.['agent'])} in the pane`);
  console.log(`herdr reports agent_session ${JSON.stringify(agent.agent?.['agent_session'] ?? null)} for ${version}`);
  const saved = readParent(parentId)?.children.find((entry) => entry.id === child.id);
  assert.ok(saved?.transcript, 'the record holds the rollout');
  assert.equal(rolloutMeta(saved.transcript)?.id, child.session?.value);
  // The folder was trusted for this run only: Codex wrote no trust into its config.
  assert.doesNotMatch(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'), /trust_level/);

  // The report went through the child's own server: the parent's spool holds
  // a done report with the word only the brief holds.
  const report = await until(() => spooled(parentId, child.id), "the parent_report in the parent's spool", 120_000).catch(async (error: unknown) => {
    console.log(`pane:\n${await herdr.paneRead({ paneId: child.paneId, source: 'recent_unwrapped', lines: 40 }).catch(() => '')}`);
    throw error;
  });
  assert.equal(report.status, 'done');
  assert.match(report.text ?? '', new RegExp(word));

  // Once the turn ends, agent_read returns the final answer from the rollout.
  await until(() => codexLastMessage(saved.transcript ?? ''), 'the answer in the rollout', 60_000);
  const ctx = { client: herdr, clientFor: async () => herdr, parentId, watcher: new Watcher({ client: herdr, parentId, onEntries: () => {} }) };
  const read = await runBellwetherTool(ctx, 'agent_read', { child: child.name }, {});
  assert.equal(read, 'I reported it.');

  // A Bellwether tool outside the three stays gated: under -a never, Codex
  // refuses agent_list on the child's own server, and the refusal is the
  // tool's output in the rollout.
  const offered = models.requests.flatMap((request) => JSON.stringify(request.body?.['tools'] ?? []).match(/"name":"agent_list"/g) ?? []);
  assert.ok(offered.length > 0, "the child's server offers agent_list, so the model can try it");
  models.reply({ tool: { name: 'agent_list', input: {} }, text: 'Listing was refused.' });
  // Pane feature: the lab's parent asks its child for a second turn.
  await herdr.agentPrompt(child.paneId, 'List the agents.');
  const refusal = await until(() => {
    const lines = fs.readFileSync(saved.transcript ?? '', 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { type?: string; payload?: Record<string, unknown> });
    const output = lines.find((line) => line.type === 'response_item' && line.payload?.['type'] === 'function_call_output' && JSON.stringify(line.payload).includes('approval'));
    return output ? JSON.stringify(output.payload) : undefined;
  }, 'the refused agent_list call in the rollout', 60_000).catch(async (error: unknown) => {
    const tail = fs.readFileSync(saved.transcript ?? '', 'utf8').split('\n').filter(Boolean).slice(-8).map((line) => line.slice(0, 400));
    console.log(`rollout tail:\n${tail.join('\n')}\nmodel requests: ${models.requests.length}\npane:\n${await herdr.paneRead({ paneId: child.paneId, source: 'recent_unwrapped', lines: 30 }).catch(() => '')}`);
    throw error;
  });
  assert.match(refusal, /requires approval, but approval policy is never/);
  console.log(`agent_list: ${refusal.slice(0, 200)}`);
});
