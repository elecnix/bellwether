// Tier 1: a Claude Code child's Notification hook. The parser reads the input
// Claude Code 2.1.332 sends, by the schema in its build, and the watcher's
// rule says when herdr's status ends a dialog the hook named.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promptPath } from '../../src/core/paths.ts';
import { DIALOG_NOTIFICATIONS, claudeChildSettings, dialogFromHook, hookCommand } from '../../src/core/claude-hooks.ts';
import { hookDialogClosed } from '../../src/core/watcher.ts';
import type { ChildPrompt } from '../../src/core/types.ts';

const base = { session_id: 'example-session', transcript_path: '/var/tmp/example/t.jsonl', cwd: '/var/tmp/example', hook_event_name: 'Notification' };

test('each dialog notification type becomes an open dialog named by its message', () => {
  for (const type of DIALOG_NOTIFICATIONS) {
    assert.deepEqual(dialogFromHook(JSON.stringify({ ...base, message: 'Claude needs your permission to use Bash', notification_type: type })), { open: true, title: 'Claude needs your permission to use Bash', kind: type });
  }
});

test('a dialog with no message is named by its title, then by its type', () => {
  assert.equal(dialogFromHook(JSON.stringify({ ...base, message: '', title: 'Example server asks', notification_type: 'elicitation_dialog' }))?.title, 'Example server asks');
  assert.equal(dialogFromHook(JSON.stringify({ ...base, message: ' ', notification_type: 'permission_prompt' }))?.title, 'a Claude Code permission prompt with no message');
});

test('a notification that is not a dialog, another hook event, or text that is not JSON names nothing', () => {
  for (const type of ['idle_prompt', 'auth_success', 'agent_completed']) {
    assert.equal(dialogFromHook(JSON.stringify({ ...base, message: 'x', notification_type: type })), undefined, type);
  }
  assert.equal(dialogFromHook(JSON.stringify({ ...base, hook_event_name: 'PermissionRequest', tool_name: 'Bash', notification_type: 'permission_prompt' })), undefined);
  assert.equal(dialogFromHook('not json'), undefined);
  assert.equal(dialogFromHook('null'), undefined);
});

test('the settings hold one Notification hook, and its command quotes every argument', () => {
  const settings = claudeChildSettings("example-it's");
  assert.deepEqual(Object.keys(settings?.hooks ?? {}), ['Notification']);
  assert.equal(settings?.hooks?.Notification[0]?.matcher, DIALOG_NOTIFICATIONS.join('|'));
  assert.ok(hookCommand("example-it's").endsWith(`'claude-hook' '--child' 'example-it'\\''s'`), hookCommand("example-it's"));
});

test('one settings file holds every part a child needs, and every child gets its read set', () => {
  const reads = ['/example/bellwether-home'];
  const both = claudeChildSettings('example-child', { hook: true, disablePlugins: ['bellwether@example-market'], reads });
  assert.deepEqual(Object.keys(both).sort(), ['enabledPlugins', 'hooks', 'permissions', 'sandbox']);
  assert.deepEqual(both.enabledPlugins, { 'bellwether@example-market': false });
  const readSet = { permissions: { additionalDirectories: reads }, sandbox: { filesystem: { allowRead: reads } } };
  // A child on another machine gets no hook, and only the plugin part beside its read set.
  assert.deepEqual(claudeChildSettings('example-child', { hook: false, disablePlugins: ['bellwether@example-market'], reads }), { ...readSet, enabledPlugins: { 'bellwether@example-market': false } });
  assert.deepEqual(claudeChildSettings('example-child', { hook: false, reads }), readSet);
});

test('the read set is the Bellwether home, which holds the brief, and nothing above it', () => {
  const settings = claudeChildSettings('example-child', { hook: false });
  const home = path.resolve(process.env['BELLWETHER_HOME'] ?? '');
  assert.deepEqual(settings.permissions.additionalDirectories, [home]);
  assert.deepEqual(settings.sandbox.filesystem.allowRead, [home]);
  assert.ok(promptPath('example-child').startsWith(`${home}${path.sep}`), 'the brief is inside the read set');
  assert.ok(!settings.permissions.additionalDirectories.includes(os.homedir()), "the operator's home is not in the read set");
});

test('a hook dialog holds while herdr calls the child idle or blocked, and ends when it works or leaves blocked', () => {
  const prompt: ChildPrompt = { line: 'Claude needs your permission to use Bash', source: 'claude-code', since: '2026-01-01T00:00:00.000Z' };
  assert.equal(hookDialogClosed(prompt, 'working', 'idle'), false, 'herdr missing the dialog is not an answer');
  assert.equal(hookDialogClosed(prompt, 'idle', 'blocked'), false, 'herdr catching up is the same dialog');
  assert.equal(hookDialogClosed(prompt, 'idle', 'idle'), false);
  assert.equal(hookDialogClosed(prompt, 'idle', 'working'), true, 'an approval');
  assert.equal(hookDialogClosed(prompt, 'blocked', 'working'), true, 'an approval');
  assert.equal(hookDialogClosed(prompt, 'blocked', 'idle'), true, 'a refusal');
  assert.equal(hookDialogClosed({ ...prompt, source: 'pi' }, 'idle', 'working'), false, 'a pi prompt ends on pi\'s own notice');
  assert.equal(hookDialogClosed(undefined, 'idle', 'working'), false);
});
