// Tier 1: peer books (issue #262). The token check that the daemon holding a
// target's record runs, and the refusal that names only the caller's own
// contacts, against a scratch home.
import assert from 'node:assert/strict';
import test from 'node:test';
import { addPeer, findPeer, freedRefusal, newPeerToken, peerDoctorLines, readPeerBook, tokensMatch, unknownPeer, verifyPeer, PeerRefused } from '../../src/core/peers.ts';
import { isolate } from '../fixtures/isolated.ts';

test('the target\'s record decides: the matching token passes, and any other is refused', (t) => {
  isolate(t, 'bellwether-peers-');
  const token = newPeerToken();
  addPeer({ address: 'child-a', name: 'writer' }, { address: 'parent-p', name: 'boss', token, since: '2026-11-28T00:00:00.000Z', relation: 'former-parent' });
  assert.equal(verifyPeer('child-a', 'parent-p', token).name, 'boss');
  assert.throws(() => verifyPeer('child-a', 'parent-p', newPeerToken()), PeerRefused);
  assert.throws(() => verifyPeer('child-a', 'parent-p', token.slice(1)), /does not match/);
  assert.throws(() => verifyPeer('child-a', 'parent-p', ''), /does not match/);
  assert.throws(() => verifyPeer('child-a', 'someone-else', token), /holds no address someone-else/);
  assert.throws(() => verifyPeer('nobody', 'parent-p', token), /no peer record for nobody/);
  assert.equal(tokensMatch(token, token), true);
  assert.equal(tokensMatch('', ''), false, 'an empty token never matches');
});

test('an address the caller lacks is refused with the caller\'s own contacts only', (t) => {
  isolate(t, 'bellwether-peers-');
  addPeer({ address: 'child-a', name: 'writer' }, { address: 'parent-p', name: 'boss', token: newPeerToken(), since: 'now', relation: 'former-parent' });
  addPeer({ address: 'parent-p', name: 'boss' }, { address: 'child-a', name: 'writer', token: newPeerToken(), since: 'now', relation: 'freed-child' });
  addPeer({ address: 'parent-p', name: 'boss' }, { address: 'child-b', name: 'lighthouse', token: newPeerToken(), since: 'now', relation: 'freed-child' });
  const own = readPeerBook('child-a');
  assert.equal(findPeer(own, 'child-b'), undefined, 'a sibling the parent also freed is not in the child\'s book');
  const refusal = unknownPeer(own, 'child-b');
  assert.match(refusal, /your contacts: boss \(parent-p\)\.$/);
  assert.doesNotMatch(refusal.replace('"child-b"', ''), /lighthouse|child-b/);
  assert.match(unknownPeer(undefined, 'x'), /You hold no peer addresses/);
  assert.equal(findPeer(own, 'boss')?.address, 'parent-p', 'a name only one entry carries finds it');
});

test('doctor names each freeing from the owner\'s side, and a freed agent\'s refusal names its former parent', (t) => {
  isolate(t, 'bellwether-peers-');
  const token = newPeerToken();
  addPeer({ address: 'child-a', name: 'writer' }, { address: 'parent-p', name: 'boss', token, since: 'then', relation: 'former-parent' }, { at: '2026-11-28T00:00:00.000Z', by: 'parent-p', byName: 'boss', name: 'writer', kind: 'claude' });
  addPeer({ address: 'parent-p', name: 'boss' }, { address: 'child-a', name: 'writer', token, since: 'then', relation: 'freed-child', host: 'child-box' });
  const lines = peerDoctorLines();
  assert.ok(lines.includes('ok    parent-p freed writer (child-a) on machine child-box at then; it is a peer, reached with peer_send'), lines.join('\n'));
  assert.ok(lines.includes('ok    writer (child-a) is a freed agent, freed by boss (parent-p) at 2026-11-28T00:00:00.000Z; 1 contact'), lines.join('\n'));
  const book = readPeerBook('child-a');
  assert.ok(book);
  assert.match(freedRefusal('parent_report', book), /writer was freed by boss at 2026-11-28T00:00:00\.000Z.*peer_send to parent-p/s);
  assert.doesNotMatch(JSON.stringify(lines), new RegExp(token), 'doctor never prints a token');
});
