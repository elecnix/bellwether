// Tier 1: the delivery family has one writer (issue #278). The fields that say
// what happened to a message or a brief on its way into a child's session are
// written only in src/core/delivery.ts, through its transitions, so a field
// means the same thing to every module that reads it. These cases fail when
// any other file in src/ assigns or deletes one of those fields, copies a
// record with one of them changed, or builds a message, brief delivery or
// teleport notice that names one. The typecheck holds the other half: the
// types declare each field readonly, so a write through any alias fails
// there, and this scan catches the casts and copies the typecheck lets through.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DELIVERY_FIELDS } from '../../src/core/delivery.ts';
import { ROOT, ownerScanner } from '../fixtures/field-owner.ts';

const OWNER = path.join('src', 'core', 'delivery.ts');

/** Writes to a field of the same name on an object that is not a message, a brief or a notice, each with its reason. */
const NOT_MINE: Record<string, string> = {
  'src/core/screen.ts last': 'a run of text on a screen line',
  'src/daemon/server.ts record': "the far machine's relay record, which keeps the messages its session has not read",
};

const scanner = ownerScanner({ owner: OWNER, fields: DELIVERY_FIELDS, notMine: NOT_MINE, literalTypes: ['ChildRecord', 'ChildMessage', 'ChildBrief', 'BriefDelivery', 'TeleportNoticeRecord'] });

test('the scan flags each way a module could write a delivery field without the owner', () => {
  const rules = (source: string): string[] => scanner.scanSource('src/core/example.ts', source).map((finding) => finding.rule);
  assert.deepEqual(rules('message.readAt = at;'), ['write']);
  assert.deepEqual(rules('delete found.undelivered;'), ['write']);
  assert.deepEqual(rules('found.via ??= ack.via;'), ['write']);
  assert.deepEqual(rules('(message as { relayInDoubt?: string }).relayInDoubt = why;'), ['write'], 'a cast past readonly');
  assert.deepEqual(rules("message['typedInDoubt'] = why;"), ['write']);
  assert.deepEqual(rules('brief.delivery = handed.delivery;'), ['write']);
  assert.deepEqual(rules('entry.messages = kept;'), ['write']);
  assert.deepEqual(rules('Object.assign(message, { readAt });'), ['assign']);
  assert.deepEqual(rules("const refused: ChildMessage = { id, at, path: 'keystrokes', preview, undelivered: why };"), ['literal']);
  assert.deepEqual(rules('remember({ ...message, typedInDoubt: why });'), ['copy']);
  assert.deepEqual(rules('const next = { ...delivery, takenAt: turn };'), ['copy']);
  assert.deepEqual(rules('upsertChild(id, { ...original, messages: current.messages });'), ['copy']);
});

test('the scan leaves reads, other objects and the owner alone', () => {
  const rules = (source: string, file = 'src/core/example.ts'): string[] => scanner.scanSource(file, source).map((finding) => finding.rule);
  assert.deepEqual(rules('if (message.readAt) return;'), []);
  assert.deepEqual(rules('const { readAt, ...rest } = message;'), []);
  assert.deepEqual(rules('removeChildFiles(id, cwd, { briefs: false });'), [], 'an options object');
  assert.deepEqual(rules('message.readAt = at;', OWNER), []);
});

test('no file but src/core/delivery.ts writes a delivery field', () => {
  assert.deepEqual(
    scanner.scanAll().map((finding) => `${finding.file}:${finding.line} ${finding.rule}: ${finding.text}`),
    [],
    'call a transition in src/core/delivery.ts instead (issue #278). A field of the same name on another kind of object goes in NOT_MINE with the reason.',
  );
});

test('every exemption still names a write the scan would otherwise flag', () => {
  assert.deepEqual(scanner.staleExemptions(), [], 'these no longer write a delivery field, so remove their exemptions');
});

test('the types declare every delivery field readonly, so the typecheck sees every alias', () => {
  const types = fs.readFileSync(path.join(ROOT, 'src', 'core', 'types.ts'), 'utf8') + fs.readFileSync(path.join(ROOT, 'src', 'core', 'teleport-plan.ts'), 'utf8');
  const loose: string[] = [];
  const owned: Record<string, readonly string[]> = {
    ChildRecord: ['messages', 'briefs'],
    ChildBrief: ['delivery'],
    ChildMessage: ['via', 'readAt', 'undelivered', 'relayInDoubt', 'typedInDoubt', 'unanswered', 'held', 'text', 'from'],
    BriefDelivery: ['via', 'readAt', 'receivedAt', 'takenAt', 'takenBy', 'readFrom', 'resentFrom', 'unanswered'],
    TeleportNoticeRecord: ['via', 'readAt', 'receivedAt', 'takenAt', 'undelivered'],
  };
  for (const [type, fields] of Object.entries(owned)) {
    const body = new RegExp(`export interface ${type} \\{([\\s\\S]*?)\\n\\}`).exec(types)?.[1] ?? '';
    assert.ok(body, `${type} was not found`);
    for (const field of fields) if (!new RegExp(`^\\s+readonly ${field}\\??:`, 'm').test(body)) loose.push(`${type}.${field}`);
  }
  assert.deepEqual(loose, [], 'declare these fields readonly');
});

test('the family covers the fields the design matrix names', () => {
  // docs/design-matrix.md, step 2. A field leaves the family only by a change to this list.
  const named = ['readAt', 'undelivered', 'relayInDoubt', 'receivedAt', 'takenAt', 'takenBy', 'messages', 'briefs', 'typedInDoubt', 'readFrom'];
  assert.deepEqual(named.filter((field) => !DELIVERY_FIELDS.includes(field as never)), []);
});
