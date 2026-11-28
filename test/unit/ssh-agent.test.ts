// Tier 1: what Bellwether can tell about the SSH agent a daemon's ssh inherits
// (issue #245). A daemon handed over from an SSH session starts without
// SSH_AUTH_SOCK, and a relay whose key lives only in an agent then fails a
// retry later. These cases cover reading `ssh -G`, deciding where a host's key
// comes from, the sentence a hand-over prints, and doctor's line for a relay.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { agentLossNotice, hasAgent, keySource, parseSshConfig, relayAgentLine } from '../../src/core/ssh-agent.ts';

test('an agent counts only when SSH_AUTH_SOCK names a path that exists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-agent-'));
  const socket = path.join(dir, 'agent.sock');
  fs.writeFileSync(socket, '');
  try {
    assert.equal(hasAgent({ SSH_AUTH_SOCK: socket }), true);
    assert.equal(hasAgent({}), false);
    assert.equal(hasAgent({ SSH_AUTH_SOCK: '' }), false);
    assert.equal(hasAgent({ SSH_AUTH_SOCK: path.join(dir, 'gone.sock') }), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ssh -G output gives the identity agent and the key files, with ~ expanded', () => {
  const config = parseSshConfig(['host mac', 'user someone', 'identityagent /Users/someone/agent.sock', 'identityfile ~/.ssh/id_ed25519', 'identityfile /keys/mac'].join('\n'), '/home/someone');
  assert.deepEqual(config, { identityAgent: '/Users/someone/agent.sock', identityFiles: ['/home/someone/.ssh/id_ed25519', '/keys/mac'] });
  assert.deepEqual(parseSshConfig('host box\nidentityfile ~/.ssh/id_rsa\n', '/h'), { identityFiles: ['/h/.ssh/id_rsa'] });
});

test("a host takes its key from the daemon's agent only when its entry names no IdentityAgent and no key file that exists", () => {
  const exists = (file: string) => file === '/keys/present';
  assert.equal(keySource({ identityFiles: ['/keys/missing'] }, exists), 'agent');
  assert.equal(keySource({ identityAgent: 'SSH_AUTH_SOCK', identityFiles: [] }, exists), 'agent');
  assert.equal(keySource({ identityAgent: '$SSH_AUTH_SOCK', identityFiles: [] }, exists), 'agent');
  assert.equal(keySource({ identityFiles: ['/keys/missing', '/keys/present'] }, exists), 'key-file');
  assert.equal(keySource({ identityAgent: '/Users/someone/agent.sock', identityFiles: [] }, exists), 'identity-agent');
  assert.equal(keySource({ identityAgent: 'none', identityFiles: ['/keys/missing'] }, exists), 'none');
});

test('a hand-over to a daemon without an agent names each relay that needs one, and what to add to ~/.ssh/config', () => {
  const notice = agentLossNotice({ replacedHadAgent: true, startsWithAgent: false, hosts: [{ host: 'mac', target: 'mac', source: 'agent' }, { host: 'box', target: 'box', source: 'key-file' }] });
  assert.ok(notice);
  assert.match(notice, /starts without SSH_AUTH_SOCK, though the daemon it replaces had one/);
  assert.match(notice, /relay to mac will fail with Permission denied/);
  assert.doesNotMatch(notice, /\bbox\b/);
  assert.match(notice, /Add an IdentityAgent or IdentityFile line under Host mac in ~\/\.ssh\/config/);
});

test('a hand-over that keeps an agent, or whose hosts each name a key, says nothing', () => {
  assert.equal(agentLossNotice({ replacedHadAgent: true, startsWithAgent: true, hosts: [{ host: 'mac', target: 'mac', source: 'agent' }] }), undefined);
  assert.equal(agentLossNotice({ replacedHadAgent: true, startsWithAgent: false, hosts: [{ host: 'mac', target: 'mac', source: 'identity-agent' }] }), undefined);
});

test("a hand-over that cannot read a host's ssh config still warns when the replaced daemon had an agent", () => {
  const notice = agentLossNotice({ replacedHadAgent: true, startsWithAgent: false, hosts: [{ host: 'mac', target: 'mac-ssh' }] });
  assert.ok(notice);
  assert.match(notice, /relay to mac will fail with Permission denied if its key lives only in an agent/);
  assert.match(notice, /under Host mac-ssh/);
  const noRelays = agentLossNotice({ replacedHadAgent: true, startsWithAgent: false, hosts: [] });
  assert.ok(noRelays);
  assert.match(noRelays, /IdentityAgent or IdentityFile/);
  assert.equal(agentLossNotice({ startsWithAgent: false, hosts: [] }), undefined);
});

test("doctor names a failing relay whose ssh ran without an agent, and stays quiet otherwise", () => {
  const base = { host: 'mac', target: 'mac-ssh', status: 'reconnecting' as const, since: '2026-11-28T05:00:00.000Z', attempts: 3, children: ['c1'] };
  const line = relayAgentLine({ ...base, sshAgent: false });
  assert.ok(line);
  assert.match(line, /the daemon started without SSH_AUTH_SOCK, so its ssh to mac-ssh ran with no agent/);
  assert.match(line, /add an IdentityAgent or IdentityFile line under Host mac-ssh in ~\/\.ssh\/config/);
  assert.match(line, /bellwether drain, then bellwether relay-bridge < \/dev\/null from a shell that has the agent/);
  assert.equal(relayAgentLine({ ...base, sshAgent: true }), undefined);
  assert.equal(relayAgentLine(base), undefined, 'an older daemon does not say, so doctor does not guess');
  assert.equal(relayAgentLine({ ...base, status: 'connected', sshAgent: false }), undefined);
});
