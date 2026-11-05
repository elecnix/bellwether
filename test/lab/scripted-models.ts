// Tier 3: the scripted model endpoints. Pi reaches the OpenAI-compatible one
// and Claude reaches the Anthropic Messages one, so a lab run needs no real
// model call. The stall reply is the stuck producer: the server writes the
// headers and then holds the body until the test releases it.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ScriptedReply {
  /** The assistant text the harness receives. */
  text?: string;
  /** A tool call the harness will try to run, such as a Bash call. */
  tool?: { name: string; input: Record<string, unknown> };
  /** Write the headers, then hold the body until release(), as a stall does. */
  stall?: boolean;
  /** Wait this long before answering, so a turn stays visibly working. */
  delayMs?: number;
}

export interface RecordedModelRequest {
  path: string;
  model: string | undefined;
  stream: boolean;
  body: Record<string, unknown> | undefined;
}

export interface ScriptedModels {
  /** The base URL a harness points at, with no trailing slash. */
  readonly url: string;
  readonly requests: RecordedModelRequest[];
  /** Replace the reply every later request receives. */
  reply(next: ScriptedReply): void;
  /** Give each later request the next reply, then keep the last one. */
  sequence(next: ScriptedReply[]): void;
  /** Let every stalled response finish. */
  release(): void;
  stop(): Promise<void>;
}

function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function sse(payload: unknown): string {
  return `event: ${(payload as { type: string }).type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function anthropicBody(model: string, reply: ScriptedReply): unknown {
  const content = reply.tool
    ? [{ type: 'tool_use', id: 'toolu_scripted', name: reply.tool.name, input: reply.tool.input }]
    : [{ type: 'text', text: reply.text ?? 'ok' }];
  return {
    id: `msg_scripted_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: reply.tool ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 10 },
  };
}

function anthropicStream(model: string, reply: ScriptedReply): string {
  const parts = [
    sse({
      type: 'message_start',
      message: { id: `msg_scripted_${Date.now()}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } },
    }),
  ];
  if (reply.tool) {
    parts.push(sse({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_scripted', name: reply.tool.name, input: {} } }));
    parts.push(sse({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(reply.tool.input) } }));
    parts.push(sse({ type: 'content_block_stop', index: 0 }));
  } else {
    parts.push(sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
    parts.push(sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply.text ?? 'ok' } }));
    parts.push(sse({ type: 'content_block_stop', index: 0 }));
  }
  parts.push(sse({ type: 'message_delta', delta: { stop_reason: reply.tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } }));
  parts.push(sse({ type: 'message_stop' }));
  return parts.join('');
}

function openAiBody(model: string, reply: ScriptedReply): unknown {
  const message = reply.tool
    ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_scripted', type: 'function', function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.input) } }] }
    : { role: 'assistant', content: reply.text ?? 'ok' };
  return {
    id: `chatcmpl_scripted_${Date.now()}`,
    object: 'chat.completion',
    created: 0,
    model,
    choices: [{ index: 0, message, finish_reason: reply.tool ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
  };
}

function openAiStream(model: string, reply: ScriptedReply): string {
  const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
    `data: ${JSON.stringify({ id: `chatcmpl_scripted_${Date.now()}`, object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const parts = [chunk({ role: 'assistant' }, null)];
  if (reply.tool) parts.push(chunk({ tool_calls: [{ index: 0, id: 'call_scripted', type: 'function', function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.input) } }] }, null));
  else parts.push(chunk({ content: reply.text ?? 'ok' }, null));
  parts.push(chunk({}, reply.tool ? 'tool_calls' : 'stop'));
  parts.push('data: [DONE]\n\n');
  return parts.join('');
}

export async function startScriptedModels(initial: ScriptedReply = {}): Promise<ScriptedModels> {
  let current = initial;
  const queued: ScriptedReply[] = [];
  const stalled: http.ServerResponse[] = [];
  const requests: RecordedModelRequest[] = [];

  const finishStalled = (): void => {
    for (const response of stalled.splice(0)) {
      if (response.writableEnded) continue;
      response.end();
    }
  };

  const server = http.createServer((request, response) => {
    void (async () => {
      const raw = await readBody(request);
      let body: Record<string, unknown> | undefined;
      try {
        body = raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
      } catch {
        body = undefined;
      }
      const path = request.url ?? '/';
      const model = typeof body?.['model'] === 'string' ? body['model'] : undefined;
      const stream = body?.['stream'] !== false;
      requests.push({ path, model: model ?? undefined, stream, body });

      if (path.startsWith('/v1/messages/count_tokens')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ input_tokens: 100 }));
        return;
      }

      const reply = queued.length > 0 ? (queued.shift() as ScriptedReply) : current;
      current = reply;
      const anthropic = path.startsWith('/v1/messages');

      if (reply.delayMs !== undefined && reply.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
      }

      if (reply.stall) {
        // Headers first, then nothing until the test releases it.
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        response.write(anthropic ? sse({ type: 'message_start', message: { id: 'msg_stalled', type: 'message', role: 'assistant', model: model ?? 'scripted', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }) : 'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n');
        response.flushHeaders();
        stalled.push(response);
        return;
      }

      if (!stream) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(anthropic ? anthropicBody(model ?? 'scripted', reply) : openAiBody(model ?? 'scripted', reply)));
        return;
      }

      if (anthropic) {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        response.end(anthropicStream(model ?? 'scripted', reply));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      response.end(openAiStream(model ?? 'scripted', reply));
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    reply(next: ScriptedReply): void {
      queued.length = 0;
      current = next;
    },
    sequence(next: ScriptedReply[]): void {
      queued.splice(0, queued.length, ...next);
    },
    release: finishStalled,
    async stop(): Promise<void> {
      finishStalled();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
