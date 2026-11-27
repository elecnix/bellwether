// Tier 1: the sentence a parent reads when a bellwether command on another
// machine fails. It leads with the far end's own error, never with the stack
// frames or the Node.js banner that end a crash, and it advises an upgrade only
// when the far end's failure shows a release difference.
import assert from 'node:assert/strict';
import test from 'node:test';
import { describeFailure, farErrorLine, releaseAdvice } from '../../src/core/ssh.ts';
import { tooDeep } from '../../src/core/depth.ts';
import { emptyParent } from '../../src/core/registry.ts';
import { toolSchema } from '../../src/integrations/tools.ts';

/** What an older bellwether prints when it throws on an argument it does not know. */
const NODE_CRASH = [
  'file:///opt/bellwether/dist/cli.js:79',
  '    if (!names.includes(name)) throw new Error(`unknown argument ${token}`);',
  '                                     ^',
  '',
  'Error: unknown argument --brief-stdin; expected --child, --name, --kind, --parent, --cwd',
  '    at exactFlags (file:///opt/bellwether/dist/cli.js:79:43)',
  '    at relayRegister (file:///opt/bellwether/dist/cli.js:516:18)',
  '    at main (file:///opt/bellwether/dist/cli.js:369:52)',
  '    at async onImport.tracePromise (node:internal/modules/esm/loader:547:26)',
  '    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:116:5)',
  '',
  'Node.js v22.22.1',
  '',
].join('\n');

test('the far end\'s own Error line leads, and the frames and the Node.js banner stay out', () => {
  const message = describeFailure('child-box', { code: 1, stdout: '', stderr: NODE_CRASH });
  assert.match(message, /^ssh child-box exited with 1: Error: unknown argument --brief-stdin/);
  assert.doesNotMatch(message, /Node\.js v/);
  assert.doesNotMatch(message, / at /);
  assert.doesNotMatch(message, /more line/, 'the source excerpt above the caret is not output left out');
});

test('a far bellwether\'s one-line error is the line picked', () => {
  const stderr = 'Warning: Permanently added \'child-box\' (ED25519) to the list of known hosts.\nbellwether relay-cleanup: EACCES: permission denied, unlink \'/x/brief.md\'\n';
  assert.equal(farErrorLine(stderr), 'bellwether relay-cleanup: EACCES: permission denied, unlink \'/x/brief.md\'');
});

test('without an error line, the first line that is not a frame or a banner is picked', () => {
  assert.equal(farErrorLine('ssh: connect to host child-box port 22: Connection refused\n'), 'ssh: connect to host child-box port 22: Connection refused');
  assert.equal(farErrorLine('    at a (x.js:1:1)\n\nNode.js v22.22.1\n'), undefined);
});

test('context after the cause is bounded, and the message says where the rest is', () => {
  const stderr = ['Error: it broke', 'detail one', 'detail two', 'detail three', 'detail four', 'detail five'].join('\n');
  const message = describeFailure('child-box', { code: 1, stdout: '', stderr, log: '/home/x/.bellwether/logs/ssh/child-box.log' });
  assert.match(message, /Error: it broke \/ detail one \/ detail two/);
  assert.doesNotMatch(message, /detail three/);
  assert.match(message, /3 more lines in \/home\/x\/\.bellwether\/logs\/ssh\/child-box\.log/);
});

test('an unknown argument that a newer release brought names that release, rather than "upgrade"', () => {
  const message = describeFailure('child-box', { code: 1, stdout: '', stderr: NODE_CRASH, command: ['relay-register', '--child', 'c1', '--brief-stdin', 'yes'] });
  assert.match(message, /--brief-stdin came with Bellwether 0\.1\.5/);
  assert.match(message, /bellwether that ssh runs on child-box is older/);
});

test('an unknown argument no release brought carries no upgrade advice', () => {
  const message = describeFailure('child-box', { code: 1, stdout: '', stderr: 'bellwether relay-register: unknown argument --nonsense\n', command: ['relay-register', '--nonsense', 'x'] });
  assert.doesNotMatch(message, /Upgrade|Update|Install|came with/i);
});

test('an error that says nothing of releases carries no upgrade advice', () => {
  const message = describeFailure('child-box', { code: 1, stdout: '', stderr: 'bellwether relay-register: EACCES: permission denied, mkdir \'/work/.bellwether\'\n', command: ['relay-register', '--child', 'c1', '--brief-stdin', 'yes'] });
  assert.match(message, /EACCES/);
  assert.doesNotMatch(message, /Upgrade|Update|came with/i);
});

test('a protocol mismatch at the far end still carries the update advice', () => {
  const stderr = 'bellwether relay-bridge: protocol_mismatch: the client spoke protocol 4, and this daemon serves 2 to 3\n';
  const message = describeFailure('child-box', { code: 1, stdout: '', stderr, command: ['relay-bridge'] });
  assert.match(message, /protocol_mismatch/);
  assert.match(message, /Update @elecnix\/bellwether on child-box/);
});

test('a command the far bellwether lacks names the release that brought it', () => {
  const message = describeFailure('child-box', { code: 1, stdout: 'Usage: bellwether <spawn|watch|list>\n', stderr: '', command: ['relay-cleanup', '--child', 'c1'] });
  assert.match(message, /relay-cleanup came with Bellwether 0\.1\.5/);
});

test('a machine with no bellwether is told to install it', () => {
  const message = describeFailure('child-box', { code: 78, stdout: '', stderr: 'no bellwether command on this machine; install @elecnix/bellwether there\n', command: ['relay-cleanup'] });
  assert.match(message, /no bellwether command on this machine/);
});

test('a ceiling of one reads "1 level deep"', () => {
  const root = emptyParent('pi', 'depth-words', '/work');
  assert.match(tooDeep(root, 1, 'kid'), /Bellwether is 1 level deep already/);
  assert.match(tooDeep(root, 2, 'kid'), /Bellwether is 2 levels deep already/);
});

test('max_depth names both its jobs: the descendants\' depth, and the gate on the call that passes it', () => {
  const properties = toolSchema('agent_spawn')?.['properties'] as Record<string, { description: string }>;
  const description = properties['max_depth']?.description ?? '';
  assert.match(description, /descendants may reach/);
  assert.match(description, /gates this call/);
  assert.match(description, /max_depth 0 refuses/);
});

test('a far bellwether whose help lists no move verbs is told the release that brought them', () => {
  const advice = releaseAdvice('child-box', { code: 0, stdout: 'Usage: bellwether <daemon|spawn|watch|list>\n', stderr: '', command: ['move-probe'] });
  assert.match(advice ?? '', /move-probe came with Bellwether 0\.1\.5/);
});
