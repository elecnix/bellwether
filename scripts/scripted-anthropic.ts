// A scripted Anthropic Messages endpoint, so a probe can drive Claude Code
// without a model call. Every request is appended to LOG as one JSON line,
// which is the evidence: a POST is a turn, and the body says what the model
// would have seen.
//
//   PORT=8788 LOG=/tmp/requests.jsonl node scripts/scripted-anthropic.ts
//
// HOLD_UNTIL names a file the server waits for before answering, so a probe
// can send a channel notification in the middle of a turn.
import http from 'node:http';
import fs from 'node:fs';
import process from 'node:process';

const port = Number.parseInt(process.env['PORT'] ?? '8788', 10);
const logPath = process.env['LOG'];
const holdUntil = process.env['HOLD_UNTIL'];
const holdTimeoutMs = Number.parseInt(process.env['HOLD_TIMEOUT_MS'] ?? '60000', 10);
const replyText = process.env['REPLY_TEXT'] ?? 'ok';

function record(entry: Record<string, unknown>): void {
  if (!logPath) return;
  fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait for the release file, so the caller can act mid-turn. HOLD_EACH
 * removes the file after releasing, so the next request holds again. */
async function waitForRelease(): Promise<void> {
  if (!holdUntil) return;
  const deadline = Date.now() + holdTimeoutMs;
  while (!fs.existsSync(holdUntil) && Date.now() < deadline) await sleep(50);
  if (process.env['HOLD_EACH'] !== '0') {
    try {
      fs.unlinkSync(holdUntil);
    } catch {
      // already gone
    }
  }
}

function sse(payload: unknown): string {
  return `event: ${(payload as { type: string }).type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function messageEvents(model: string, text: string): string {
  return [
    sse({
      type: 'message_start',
      message: {
        id: `msg_probe_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 1 },
      },
    }),
    sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
    sse({ type: 'content_block_stop', index: 0 }),
    sse({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: text.length },
    }),
    sse({ type: 'message_stop' }),
  ].join('');
}

const server = http.createServer((request, response) => {
  const path = request.url ?? '/';
  void (async () => {
    const raw = await readBody(request);
    let body: Record<string, unknown> | undefined;
    try {
      body = raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
    } catch {
      body = undefined;
    }
    record({
      at: new Date().toISOString(),
      method: request.method,
      path,
      model: body?.['model'],
      stream: body?.['stream'],
      contentType: request.headers['content-type'],
      hasApiKey: Boolean(request.headers['x-api-key']),
      authorization: request.headers['authorization'] ? 'present' : undefined,
      body,
    });
    console.log(`${request.method} ${path} model=${String(body?.['model'])}`);

    if (path.startsWith('/v1/messages/count_tokens')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ input_tokens: 100 }));
      return;
    }
    if (!path.startsWith('/v1/messages')) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `probe has no ${path}` } }));
      return;
    }

    await waitForRelease();
    const model = typeof body?.['model'] === 'string' ? body['model'] : 'probe-model';
    if (body?.['stream'] === false) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          id: `msg_probe_${Date.now()}`,
          type: 'message',
          role: 'assistant',
          model,
          content: [{ type: 'text', text: replyText }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: replyText.length },
        }),
      );
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    response.end(messageEvents(model, replyText));
  })().catch((error: unknown) => {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: String(error) } }));
  });
});

server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  const bound = typeof address === 'object' && address !== null ? address.port : port;
  console.log(`scripted anthropic listening on http://127.0.0.1:${bound}`);
});
