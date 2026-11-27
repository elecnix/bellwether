import assert from 'node:assert/strict';
import test from 'node:test';
import { childLabel } from '../../src/core/label.ts';

test('a child is named with its pane id', () => {
  assert.equal(childLabel({ name: 'npm-publish', paneId: 'w74:pJ', id: '0123456789abcdef' }), 'npm-publish (w74:pJ)');
});

test('a child without a pane yet is named with the start of its id', () => {
  assert.equal(childLabel({ name: 'npm-publish', paneId: '', id: '0123456789abcdef' }), 'npm-publish (01234567)');
});
