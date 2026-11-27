// The pieces of the start check that need no socket: when a pane's foreground
// says the harness exited, and which of its lines an error quotes. The screens
// follow a real pi 1.6 pane read through herdr.
import assert from 'node:assert/strict';
import test from 'node:test';
import { fatalLine, ForegroundTracker, processInfoOf, startupQuote } from '../../src/core/start-check.ts';
import { pi } from '../../src/core/harnesses/pi.ts';

test('an exit counts only after the harness held the foreground', () => {
  const tracker = new ForegroundTracker();
  // Before the shell runs the typed line, the shell holds the foreground.
  assert.equal(tracker.exited({ shellPid: 10, foregroundGroup: 10 }), false);
  assert.equal(tracker.exited({ shellPid: 10, foregroundGroup: 20 }), false);
  assert.equal(tracker.sawHarness, true);
  assert.equal(tracker.exited({ shellPid: 10, foregroundGroup: 10 }), true);
  assert.equal(new ForegroundTracker().exited(undefined), false);
});

test('herdr pane.process_info is read for the shell and the foreground group', () => {
  assert.deepEqual(processInfoOf({ type: 'pane_process_info', process_info: { shell_pid: 3, foreground_process_group_id: 3 } }), { shellPid: 3, foregroundGroup: 3 });
  assert.equal(processInfoOf({ type: 'ok' }), undefined);
});

test("an exited harness is quoted from the lines after its launch line, without the shell's prompt", () => {
  const screen = '$ command pi --provider example-provider --model example-model\nError: Unknown provider "example-provider". Use --list-models to see available providers/models.\n$ ';
  assert.equal(startupQuote(screen, 'pi'), 'Error: Unknown provider "example-provider". Use --list-models to see available providers/models.');
  assert.equal(startupQuote(screen, 'pi', pi.startupFatal), 'Error: Unknown provider "example-provider". Use --list-models to see available providers/models.');
});

test("pi's fatal line is found on a screen where pi stays at its prompt", () => {
  const screen = [' ▀▀█  v1.6.1', ' Error: No API key found for example-provider.', ' Use /login to log into a provider via OAuth or API key.', ' 0.0%/200k (auto)'].join('\n');
  assert.equal(fatalLine(screen, pi.startupFatal as RegExp), 'Error: No API key found for example-provider.');
  assert.equal(fatalLine(' ▀▀█  v1.6.1\n Reading the brief…', pi.startupFatal as RegExp), undefined);
});
