// Tier 2: the client against a real Unix socket that speaks the herdr wire
// protocol. No herdr binary and no network, but a real connection, real
// framing and real parser errors.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HerdrApiError, openHerdrSubscription, requestHerdr, resolveSocketPath } from '../../src/core/herdr-client.ts';
import { startFakeHerdr } from '../fixtures/fake-herdr.ts';

/** Poll until the predicate holds, then fail rather than hang. */
async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('the condition never became true');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const subscription = { subscriptions: [] };

test('a request round-trips and answers with its result', async () => {
  const server = await startFakeHerdr();
  try {
    const result = await requestHerdr(server.socketPath, { id: 'r1', method: 'pane.read', params: { pane_id: 'w1:p1', source: 'recent' } });
    assert.deepEqual(result, { type: 'pane_read', read: { pane_id: 'w1:p1', source: 'recent', format: 'text', text: 'screen' } });
    assert.equal(server.requests[0]?.method, 'pane.read');
  } finally {
    await server.stop();
  }
});

test('a request missing a required field is refused with its code', async () => {
  const server = await startFakeHerdr();
  try {
    await assert.rejects(
      requestHerdr(server.socketPath, { id: 'r2', method: 'pane.read', params: { pane_id: 'w1:p1' } }),
      (error: unknown) => error instanceof HerdrApiError && error.code === 'invalid_request',
    );
  } finally {
    await server.stop();
  }
});

test('an unknown method is refused rather than silently accepted', async () => {
  const server = await startFakeHerdr();
  try {
    await assert.rejects(
      requestHerdr(server.socketPath, { id: 'r3', method: 'pane.explode', params: {} }),
      (error: unknown) => error instanceof HerdrApiError && error.code === 'invalid_request',
    );
  } finally {
    await server.stop();
  }
});

test('a subscription resolves on its acknowledgement and delivers a later event', async () => {
  const server = await startFakeHerdr();
  const controller = new AbortController();
  try {
    const events: string[] = [];
    const live = await openHerdrSubscription(server.socketPath, { id: 's1', method: 'events.subscribe', params: subscription }, (event) => events.push(event.event), controller.signal);
    await server.waitFor('events.subscribe');

    server.send({ event: 'pane_agent_status_changed', data: { pane_id: 'w1:p1' } });
    await until(() => events.length === 1);
    assert.deepEqual(events, ['pane_agent_status_changed']);
    live.close();
  } finally {
    controller.abort();
    await server.stop();
  }
});

test('an event written ahead of the acknowledgement is buffered, not lost', async () => {
  const server = await startFakeHerdr({
    subscribe: (socket, request) => {
      // The event lands before the ack, in one write.
      socket.write(`${JSON.stringify({ event: 'pane_closed', data: { pane_id: 'w1:p1' } })}\n${JSON.stringify({ id: request.id, result: { type: 'subscription_started' } })}\n`);
      return true;
    },
  });
  const controller = new AbortController();
  try {
    const events: string[] = [];
    const live = await openHerdrSubscription(server.socketPath, { id: 's2', method: 'events.subscribe', params: subscription }, (event) => events.push(event.event), controller.signal);
    assert.deepEqual(events, ['pane_closed']);
    live.close();
  } finally {
    controller.abort();
    await server.stop();
  }
});

test('an events_lost error closes the subscription with that error', async () => {
  const server = await startFakeHerdr();
  const controller = new AbortController();
  try {
    const live = await openHerdrSubscription(server.socketPath, { id: 's3', method: 'events.subscribe', params: subscription }, () => {}, controller.signal);
    server.send({ error: { code: 'events_lost', message: 'the server dropped events' } });
    await assert.rejects(live.closed, (error: unknown) => error instanceof HerdrApiError && error.code === 'events_lost');
    live.close();
  } finally {
    controller.abort();
    await server.stop();
  }
});

test('a dropped connection closes the subscription rather than waiting forever', async () => {
  const server = await startFakeHerdr();
  const controller = new AbortController();
  try {
    const live = await openHerdrSubscription(server.socketPath, { id: 's4', method: 'events.subscribe', params: subscription }, () => {}, controller.signal);
    server.hangUp();
    await assert.rejects(live.closed);
    live.close();
  } finally {
    controller.abort();
    await server.stop();
  }
});

test('the fake server never binds the live herdr socket', async () => {
  const server = await startFakeHerdr();
  try {
    assert.notEqual(server.socketPath, resolveSocketPath());
    assert.equal(path.dirname(server.socketPath).startsWith(os.tmpdir()), true);
  } finally {
    await server.stop();
  }
});
