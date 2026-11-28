// Tier 1: what herdr's integration.list says about the integration a harness
// needs for herdr to report its session, and the words a refusal and a spawn
// warning use when herdr on the child's machine lacks it (issue #169).
import assert from 'node:assert/strict';
import test from 'node:test';
import { harnessFor } from '../../src/core/harnesses/index.ts';
import { describeIntegrations, missingIntegration, noSessionCause, noSessionWarning, withSessionCause } from '../../src/core/herdr-integration.ts';
import type { HerdrRequester } from '../../src/core/harnesses/types.ts';

/** herdr answering integration.list with pi in the given state, or refusing the method. */
function herdr(pi: string | undefined | Error): HerdrRequester {
  return {
    request: async (method) => {
      assert.equal(method, 'integration.list');
      if (pi instanceof Error) throw pi;
      const claude = { target: 'claude', label: 'claude', command: 'claude', available: true, state: 'current' };
      return { type: 'integration_list', integrations: pi === undefined ? [claude] : [{ target: 'pi', label: 'pi', command: 'pi', available: true, state: pi }, claude] };
    },
  };
}

test('a pi child needs herdr\'s pi integration, which is missing when herdr lists it not installed or not at all', async () => {
  const pi = harnessFor('pi');
  assert.equal(await missingIntegration(herdr('not_installed'), pi), 'pi');
  assert.equal(await missingIntegration(herdr(undefined), pi), 'pi');
  assert.equal(await missingIntegration(herdr('current'), pi), undefined);
  assert.equal(await missingIntegration(herdr('outdated'), pi), undefined, 'an outdated integration still reports sessions');
});

test('herdr that cannot answer, a missing client, or a harness that needs no integration names no cause', async () => {
  assert.equal(await missingIntegration(herdr(new Error('unknown method integration.list')), harnessFor('pi')), undefined);
  assert.equal(await missingIntegration(undefined, harnessFor('pi')), undefined);
  assert.equal(await missingIntegration(herdr('not_installed'), harnessFor('opencode')), undefined, 'opencode keeps its session in a store of its own');
  assert.equal(await missingIntegration(herdr('current'), harnessFor('claude')), undefined);
});

test('the cause and the warning name the machine and the command that fixes it', () => {
  const cause = noSessionCause('pi', 'example-box', 'worker');
  assert.match(cause, /herdr on machine example-box has no pi integration, so it never reported worker's session/);
  assert.ok(cause.includes('`herdr integration install pi` on machine example-box'), cause);
  assert.match(noSessionCause('pi', 'local', 'worker'), /herdr on this machine has no pi integration/);
  const warning = noSessionWarning('pi', 'local', 'worker');
  assert.match(warning, /^Warning: herdr on this machine has no pi integration/);
  assert.match(warning, /cannot move worker, restart it or resume it by its session/);
  assert.ok(warning.includes('`herdr integration install pi`'), warning);
});

test('a refusal keeps its words, and gains the cause only when herdr confirms the integration is missing', async () => {
  const refusal = 'worker has no recorded session.';
  assert.equal(await withSessionCause(refusal, herdr('current'), harnessFor('pi'), { name: 'worker', host: 'local' }), refusal);
  const caused = await withSessionCause(refusal, herdr('not_installed'), harnessFor('pi'), { name: 'worker', host: 'local' });
  assert.ok(caused.startsWith(`${refusal} herdr on this machine has no pi integration`), caused);
});

test('doctor names each integration a movable harness needs as present or missing, and says when herdr did not answer (issue #174)', () => {
  const states = new Map([['claude', 'current'], ['pi', 'not_installed']]);
  assert.equal(describeIntegrations(states, ['claude', 'pi'], 'example-box'), 'herdr claude integration present, herdr pi integration missing (run `herdr integration install pi` on machine example-box)');
  assert.equal(describeIntegrations(new Map([['claude', 'outdated']]), ['claude', 'pi'], undefined), 'herdr claude integration present (outdated), herdr pi integration missing (run `herdr integration install pi` on this machine)');
  // A state herdr reports that Bellwether does not know is quoted, not read as present or missing.
  assert.equal(describeIntegrations(new Map([['pi', 'example-state']]), ['pi'], undefined), 'herdr pi integration example-state, as herdr reports it');
  assert.equal(describeIntegrations(new Error('herdr integration.list timed out after 6000ms'), ['claude', 'pi'], undefined), 'herdr integrations unknown (herdr integration.list timed out after 6000ms)');
});
