// Tier 1: the daemon's wire protocol. Each case parses or refuses one line,
// with no socket and no herdr, so a malformed frame is caught before it can
// reach a client connection.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DAEMON_PROTOCOL, parseRequest, ProtocolError } from '../../src/daemon/protocol.ts';
import type { HelloRequest } from '../../src/daemon/protocol.ts';

const hello: HelloRequest = {
  type: 'hello',
  protocol: DAEMON_PROTOCOL,
  client: '0.1.0',
  parent: { harness: 'pi', session: 'session-1', cwd: '/tmp', host: 'machine', depth: 0, herdrSocket: '/tmp/herdr.sock' },
};

test('a hello parses with its parent fields', () => {
  const parsed = parseRequest(JSON.stringify(hello));
  assert.equal(parsed.type, 'hello');
  if (parsed.type !== 'hello') return;
  assert.equal(parsed.parent.session, 'session-1');
  assert.equal(parsed.parent.herdrSocket, '/tmp/herdr.sock');
});

test('a call carries its id, tool and arguments', () => {
  const parsed = parseRequest(JSON.stringify({ type: 'call', id: 'c1', tool: 'agent_list', args: {} }));
  assert.deepEqual(parsed, { type: 'call', id: 'c1', tool: 'agent_list', args: {} });
});

test('a receipt carries its ids', () => {
  const parsed = parseRequest(JSON.stringify({ type: 'receipt', receipts: ['bw-1', 'bw-2'] }));
  assert.deepEqual(parsed, { type: 'receipt', receipts: ['bw-1', 'bw-2'] });
});

test('an unknown type is refused with a code', () => {
  assert.throws(() => parseRequest(JSON.stringify({ type: 'shutdown-all' })), (error: unknown) => error instanceof ProtocolError && error.code === 'unknown_type');
});

test('a hello without a protocol is refused', () => {
  const { protocol: _protocol, ...rest } = hello;
  assert.throws(() => parseRequest(JSON.stringify(rest)), (error: unknown) => error instanceof ProtocolError && error.code === 'invalid_hello');
});

test('a hello without a session is refused', () => {
  const broken = { ...hello, parent: { ...hello.parent, session: '' } };
  assert.throws(() => parseRequest(JSON.stringify(broken)), (error: unknown) => error instanceof ProtocolError && error.code === 'invalid_hello');
});

test('a call without a tool is refused', () => {
  assert.throws(() => parseRequest(JSON.stringify({ type: 'call', id: 'c1', args: {} })), (error: unknown) => error instanceof ProtocolError && error.code === 'invalid_call');
});

test('a line that is not JSON is refused', () => {
  assert.throws(() => parseRequest('not json'), (error: unknown) => error instanceof ProtocolError && error.code === 'invalid_json');
});
