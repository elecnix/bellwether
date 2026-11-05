// Tier 3: the lab, against a real herdr server of its own. These cases prove
// the isolation guard, the server lifecycle and a live round-trip through the
// Bellwether client. The four-pair matrix with scripted model replies builds
// on this same fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { assertNotLiveSocket, hasHerdr, liveSocketPath, startLab } from './herdr-lab.ts';

const skip = (await hasHerdr()) ? false : 'herdr is not on PATH';

test('the guard refuses the live socket and accepts a temp one', () => {
  assert.throws(() => assertNotLiveSocket(liveSocketPath()), /refusing/);
  assert.doesNotThrow(() => assertNotLiveSocket(path.join(os.tmpdir(), 'bw-lab', 'herdr.sock')));
});

test('the lab starts a real server under its own config root', { skip }, async () => {
  const lab = await startLab();
  try {
    assert.notEqual(lab.socketPath, liveSocketPath());
    assert.equal(lab.socketPath.startsWith(lab.root), true);
    assert.equal(fs.existsSync(lab.socketPath), true);
  } finally {
    await lab.stop();
  }
});

test('a real request round-trips against the lab through the client', { skip }, async () => {
  const lab = await startLab();
  try {
    const client = new HerdrClient({ socketPath: lab.socketPath });
    const panes = await client.paneList();
    assert.equal(Array.isArray(panes), true);
    const snapshot = await client.snapshot();
    assert.equal(typeof snapshot, 'object');
  } finally {
    await lab.stop();
  }
});

test('stopping the lab leaves no socket behind', { skip }, async () => {
  const lab = await startLab();
  const socket = lab.socketPath;
  const root = lab.root;
  await lab.stop();
  assert.equal(fs.existsSync(socket), false);
  assert.equal(fs.existsSync(root), false);
});
