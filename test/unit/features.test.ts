// Tier 1: the feature table that turns a daemon's refusal into a message
// naming the operation and the release that brought it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { FEATURES, featureNamed, missingFeatureMessage, missingFrom, serves, unknownTo } from '../../src/daemon/features.ts';
import { refusalMessage } from '../../src/daemon/client.ts';
import { DAEMON_PROTOCOL, MIN_CLIENT_PROTOCOL, ProtocolError, parseRequest } from '../../src/daemon/protocol.ts';
import { daemonCallNames, toolNames } from '../../src/integrations/tools.ts';

test('every tool and every request type this install has is in the feature table', () => {
  for (const name of toolNames()) assert.equal(featureNamed(name)?.kind, 'tool', name);
  for (const name of daemonCallNames()) assert.ok(featureNamed(name), `${name} is a call the daemon runs, so the table needs it`);
  const requests = FEATURES.filter((feature) => feature.kind === 'request').map((feature) => feature.name);
  for (const name of requests) {
    try {
      parseRequest(JSON.stringify({ type: name }));
    } catch (error) {
      assert.notEqual((error as ProtocolError).code, 'unknown_type', `${name} is in the table but the daemon does not parse it`);
    }
  }
  assert.throws(() => parseRequest(JSON.stringify({ type: 'not-a-request' })), (error: unknown) => (error as ProtocolError).code === 'unknown_type');
  for (const feature of FEATURES) {
    assert.ok(feature.protocol >= MIN_CLIENT_PROTOCOL && feature.protocol <= DAEMON_PROTOCOL, `${feature.name} names protocol ${feature.protocol}`);
  }
});

test('a missing feature is named with the protocol and release that brought it, and the upgrade can wait', () => {
  assert.equal(
    missingFeatureMessage('agent_move', { protocol: 3, version: '0.1.4' }),
    '`agent_move` needs protocol 4 (Bellwether 0.1.5); this daemon serves protocol 3 (Bellwether 0.1.4). Upgrade the machine holding the daemon when convenient. Every other tool keeps working.',
  );
});

test('a daemon that lists its features is judged by its list, and an older one by its protocol, never its version', () => {
  const move = featureNamed('agent_move')!;
  assert.equal(serves({ protocol: 4, version: '0.1.5', features: ['agent_list'] }, move), false);
  assert.equal(serves({ protocol: 4, version: '0.1.5' }, move), true);
  // A build between releases carries the previous release's number, so the version proves nothing.
  assert.equal(serves({ protocol: 4, version: '0.1.4' }, move), true);
  assert.equal(serves({ protocol: 3, version: '0.1.4' }, move), false);
  assert.deepEqual(missingFrom({ protocol: 3, version: '0.1.4' }, 'tool').map((feature) => feature.name), ['agent_restart', 'agent_move']);
  assert.deepEqual(unknownTo({ protocol: 5, features: ['agent_list', 'agent_clone'] }), ['agent_clone']);
});

test('a refusal quotes the range the daemon serves and names the install to update, without blaming either side', () => {
  const text = refusalMessage('/h/daemon.sock', { daemonProtocol: 6, minProtocol: 5, version: '0.3.0', reason: 'the client spoke protocol 4, and this daemon serves 5 to 6' }, { version: '0.1.5', protocol: 4 }, '/opt/bellwether');
  assert.match(text, /the daemon on \/h\/daemon\.sock \(Bellwether 0\.3\.0\) serves protocols 5 to 6/);
  assert.match(text, /this session speaks protocols \d+ to 4 \(Bellwether 0\.1\.5\)/);
  assert.match(text, /Update the Bellwether install at \/opt\/bellwether, then start this session again\./);
  assert.doesNotMatch(text, /newer than this client/);
  const old = refusalMessage('/h/daemon.sock', { daemonProtocol: 1, reason: 'the client spoke another protocol' }, { version: '0.1.5', protocol: 4 }, '/opt/bellwether');
  assert.match(old, /serves protocol 1,/);
  assert.match(old, /Upgrade the Bellwether install that started that daemon/);
});
