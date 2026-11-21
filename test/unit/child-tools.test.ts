// Tier 1: the one tool a child runs in its own process. A report writes a
// line to the parent's spool, so it needs the child's environment and nothing
// from the daemon. Every case uses a scratch home.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spoolPath } from '../../src/core/paths.ts';
import { emptyParent, saveParent } from '../../src/core/registry.ts';
import { runChildToolLocally } from '../../src/integrations/tools.ts';

function scratch(): { home: string; parentId: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-child-tools-'));
  process.env['BELLWETHER_HOME'] = home;
  const parentId = 'pi-parent-one';
  saveParent({ ...emptyParent('pi', 'parent-one', '/tmp'), id: parentId });
  process.env['BELLWETHER_PARENT'] = parentId;
  process.env['BELLWETHER_CHILD'] = 'child-1';
  process.env['BELLWETHER_CHILD_NAME'] = 'builder';
  return { home, parentId };
}

function cleanup(home: string): void {
  delete process.env['BELLWETHER_PARENT'];
  delete process.env['BELLWETHER_CHILD'];
  delete process.env['BELLWETHER_CHILD_NAME'];
  fs.rmSync(home, { recursive: true, force: true });
}

test('a done report appends one line to the parent spool', () => {
  const { home, parentId } = scratch();
  try {
    const text = runChildToolLocally('parent_report', { status: 'done', text: 'all tests pass' });
    assert.equal(text, 'Reported done to the parent.');
    const spool = fs.readFileSync(spoolPath(parentId), 'utf8').trim().split('\n');
    assert.equal(spool.length, 1);
    const line = JSON.parse(spool[0] as string) as { status: string; text: string; childId: string; childName: string };
    assert.equal(line.status, 'done');
    assert.equal(line.text, 'all tests pass');
    assert.equal(line.childId, 'child-1');
    assert.equal(line.childName, 'builder');
  } finally {
    cleanup(home);
  }
});

test('a tool the daemon owns is not run locally', () => {
  const { home } = scratch();
  try {
    assert.equal(runChildToolLocally('agent_list', {}), undefined);
  } finally {
    cleanup(home);
  }
});

test('a report without a parent says so', () => {
  const { home } = scratch();
  try {
    delete process.env['BELLWETHER_PARENT'];
    assert.throws(() => runChildToolLocally('parent_report', { status: 'done', text: 'x' }), /BELLWETHER_PARENT/);
  } finally {
    cleanup(home);
  }
});
