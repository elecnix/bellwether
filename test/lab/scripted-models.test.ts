// Tier 3 fixtures: the two model endpoints a lab run points Pi and Claude at.
// No model call happens here, and the stall reply is the one that produces the
// stuck event, so its timing is asserted rather than assumed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { startScriptedModels } from './scripted-models.ts';

function post(url: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

test('the Anthropic endpoint answers a non-stream request with the scripted text', async () => {
  const models = await startScriptedModels({ text: 'scripted reply' });
  try {
    const response = await post(models.url, '/v1/messages', { model: 'scripted-model', stream: false, messages: [] });
    const body = (await response.json()) as { content: { type: string; text?: string }[] };
    assert.equal(body.content[0]?.type, 'text');
    assert.equal(body.content[0]?.text, 'scripted reply');
    assert.equal(models.requests.at(-1)?.model, 'scripted-model');
  } finally {
    await models.stop();
  }
});

test('the Anthropic endpoint streams the scripted text', async () => {
  const models = await startScriptedModels({ text: 'streamed reply' });
  try {
    const response = await post(models.url, '/v1/messages', { model: 'scripted-model', stream: true, messages: [] });
    const text = await response.text();
    assert.match(text, /message_start/);
    assert.match(text, /streamed reply/);
    assert.match(text, /message_stop/);
  } finally {
    await models.stop();
  }
});

test('the OpenAI endpoint answers a stream request with the scripted text', async () => {
  const models = await startScriptedModels({ text: 'openai reply' });
  try {
    const response = await post(models.url, '/v1/chat/completions', { model: 'scripted-model', stream: true, messages: [] });
    const text = await response.text();
    assert.match(text, /openai reply/);
    assert.match(text, /\[DONE\]/);
    assert.equal(models.requests.at(-1)?.stream, true);
  } finally {
    await models.stop();
  }
});

test('the OpenAI endpoint answers a non-stream request with the scripted text', async () => {
  const models = await startScriptedModels({ text: 'openai reply' });
  try {
    const response = await post(models.url, '/v1/chat/completions', { model: 'scripted-model', stream: false, messages: [] });
    const body = (await response.json()) as { choices: { message: { content: string } }[] };
    assert.equal(body.choices[0]?.message.content, 'openai reply');
  } finally {
    await models.stop();
  }
});

test('a tool call reply carries the tool name and its input', async () => {
  const models = await startScriptedModels({ tool: { name: 'Bash', input: { command: 'echo hi' } } });
  try {
    const response = await post(models.url, '/v1/messages', { model: 'scripted-model', stream: false, messages: [] });
    const body = (await response.json()) as { content: { type: string; name?: string; input?: { command?: string } }[] };
    assert.equal(body.content[0]?.type, 'tool_use');
    assert.equal(body.content[0]?.name, 'Bash');
    assert.equal(body.content[0]?.input?.command, 'echo hi');
  } finally {
    await models.stop();
  }
});

test('count_tokens answers without a reply script', async () => {
  const models = await startScriptedModels({ text: 'unused' });
  try {
    const response = await post(models.url, '/v1/messages/count_tokens', { model: 'scripted-model', messages: [] });
    const body = (await response.json()) as { input_tokens: number };
    assert.equal(body.input_tokens, 100);
  } finally {
    await models.stop();
  }
});

test('a stalled reply holds its body open until the test releases it', async () => {
  const models = await startScriptedModels();
  try {
    models.reply({ stall: true });
    const response = await post(models.url, '/v1/messages', { model: 'scripted-model', stream: true, messages: [] });
    assert.equal(response.status, 200);

    let finished = false;
    const body = response.body;
    assert.ok(body);
    const reading = (async () => {
      const reader = body.getReader();
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
      }
      finished = true;
    })();

    // Headers arrived, and the body has not ended, which is the stall.
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(finished, false);

    models.release();
    await reading;
    assert.equal(finished, true);
  } finally {
    await models.stop();
  }
});
