// Probe 1: does a channel notification start a turn, and what happens to one
// sent during a turn?
//
//   node scripts/channel-probe.ts --phase idle --session bw-probe --pane w1:p4 \
//     --inbox /tmp/bw-probe/q1/inbox.txt --log /tmp/bw-probe/req.jsonl \
//     --transcript <session>.jsonl --text "PROBE-A"
//
//   node scripts/channel-probe.ts --phase during ... --release /tmp/bw-probe/release
//
// Three independent signals are recorded, because a write to the MCP transport
// proves nothing about a turn:
//
//   - a Messages request reaching the scripted server, which is a turn;
//   - the transcript gaining an assistant message;
//   - herdr's pane status and completion_seq.
//
// `--phase during` needs the scripted server started with HOLD_UNTIL naming the
// same file as --release and HOLD_EACH=1, so each request is held until the file
// appears and the file is then removed before the next request.
//
// `--burst N` sends N lines while the first turn is held open instead of one,
// which is how the grouping claim gets measured. The default of 1 reproduces
// the single-notification case.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { HerdrClient } from '../src/core/herdr-client.ts';

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const session = flag('session') ?? 'bw-probe';
const phase = flag('phase') ?? 'idle';
const paneId = flag('pane') ?? '';
const inbox = flag('inbox') ?? '';
const logPath = flag('log') ?? '';
const release = flag('release') ?? '';

/** Accept a transcript file, or a project directory whose newest .jsonl wins. */
function resolveTranscript(value: string): string {
  if (value.length === 0 || !fs.existsSync(value)) return value;
  if (!fs.statSync(value).isDirectory()) return value;
  const files = fs
    .readdirSync(value)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => path.join(value, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0] ?? '';
}

const transcript = resolveTranscript(flag('transcript') ?? '');
const firstText = flag('text') ?? 'PROBE-A';
const secondText = flag('text2') ?? 'PROBE-B';
const seconds = Number.parseInt(flag('seconds') ?? '45', 10);
const betweenMs = Number.parseInt(flag('between') ?? '3000', 10);
const burst = Number.parseInt(flag('burst') ?? '1', 10);

if (!paneId || !inbox || !logPath) throw new Error('--pane, --inbox and --log are required');

const started = Date.now();
const note = (source: string, message: string, extra: Record<string, unknown> = {}): void => {
  console.log(JSON.stringify({ at: new Date().toISOString(), ms: Date.now() - started, source, message, ...extra }));
};
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Turn {
  at: string;
  model: string | undefined;
  channels: string[];
  suggestion: boolean;
}

/** Every Messages request, with the channel blocks the model would have read.
 * A prompt-suggestion request is marked, because it is not a turn. */
function allRequests(): Turn[] {
  if (!fs.existsSync(logPath)) return [];
  const found: Turn[] = [];
  for (const line of fs.readFileSync(logPath, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const requestPath = typeof entry['path'] === 'string' ? entry['path'] : '';
    if (!requestPath.startsWith('/v1/messages') || requestPath.startsWith('/v1/messages/count_tokens')) continue;
    const channels: string[] = [];
    const body = entry['body'];
    const messages = typeof body === 'object' && body !== null ? (body as { messages?: unknown }).messages : undefined;
    for (const message of Array.isArray(messages) ? messages : []) {
      const content = (message as { content?: unknown }).content;
      for (const part of Array.isArray(content) ? content : []) {
        const value = (part as { text?: unknown }).text;
        if (typeof value !== 'string') continue;
        for (const match of value.matchAll(/<channel[^>]*>([\s\S]*?)<\/channel>/g)) channels.push((match[1] ?? '').trim());
      }
    }
    found.push({
      at: String(entry['at']),
      model: typeof entry['model'] === 'string' ? entry['model'] : undefined,
      channels,
      suggestion: JSON.stringify(body ?? {}).includes('SUGGESTION MODE'),
    });
  }
  return found;
}

/** Requests that are turns: not a token count, not a prompt suggestion. */
function turns(): Turn[] {
  return allRequests().filter((turn) => !turn.suggestion);
}

function assistantMessages(): number {
  if (transcript.length === 0 || !fs.existsSync(transcript)) return 0;  let count = 0;
  for (const line of fs.readFileSync(transcript, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      const entry = JSON.parse(line) as { type?: string; message?: { role?: string } };
      if (entry.type === 'assistant' || entry.message?.role === 'assistant') count += 1;
    } catch {
      // a partially written last line is not evidence
    }
  }
  return count;
}

const client = new HerdrClient({ session });
async function status(): Promise<Record<string, unknown>> {
  try {
    const result = (await client.request('pane.get', { pane_id: paneId })) as { pane?: Record<string, unknown> };
    const pane = result.pane ?? {};
    return { agent_status: pane['agent_status'] ?? null, completion_seq: pane['completion_seq'] ?? null, revision: pane['revision'] ?? null };
  } catch (error) {
    return { error: String(error) };
  }
}

function send(text: string): void {
  fs.appendFileSync(inbox, `${text}\n`);
  note('sent', 'wrote one channel line', { text });
}

function answerOne(): void {
  if (release.length === 0) return;
  fs.writeFileSync(release, '');
  note('release', 'answered one held request', { turns: turns().length });
}

async function waitForTurn(after: number, label: string, timeoutMs = 60000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (turns().length > after) {
      note('turn', label, { turns: turns().length, status: await status() });
      return true;
    }
    await sleep(100);
  }
  note('timeout', `${label}: no turn within ${timeoutMs} ms`, { turns: turns().length, status: await status() });
  return false;
}

const baseTurns = turns().length;
const baseAssistant = assistantMessages();
note('start', 'baseline', { phase, turns: baseTurns, assistantMessages: baseAssistant, status: await status() });

if (phase === 'idle') {
  send(firstText);
  await waitForTurn(baseTurns, 'a turn started from an idle session');
  answerOne();
} else {
  // Mid-turn: start a turn, hold it open at the scripted server, then send the
  // second notification while Claude Code is busy.
  send(firstText);
  const first = await waitForTurn(baseTurns, 'the first turn started and is held open');
  if (first) {
    await sleep(betweenMs);
    // A burst answers the design's question about grouping: if Claude Code
    // groups events from active work into the next turn, N lines produce one
    // turn. The default of one line reproduces the single-notification case.
    for (let index = 0; index < burst; index += 1) send(`${secondText} #${index + 1}`);
    note('mid-turn', 'the second batch is queued while a turn is in flight', { burst });
    answerOne();
    const second = await waitForTurn(baseTurns + 1, 'a follow-up turn appeared after the held turn was answered');
    if (second) {
      // Let a grouped batch settle before answering, so a second follow-up turn
      // has every chance to appear before the probe counts it.
      await sleep(3000);
      answerOne();
    }
  }
}

// Tail: let the last held request through, then watch for what the model saw.
let lastTurns = turns().length;
let lastAssistant = assistantMessages();
const deadline = Date.now() + seconds * 1000;
while (Date.now() < deadline) {
  await sleep(250);
  const now = turns().length;
  if (now !== lastTurns) {
    note('turn', 'another turn arrived', { turns: now, status: await status() });
    lastTurns = now;
    answerOne();
  }
  const assistant = assistantMessages();
  if (assistant !== lastAssistant) {
    note('transcript', 'the transcript gained an assistant message', { assistantMessages: assistant });
    lastAssistant = assistant;
  }
}
// Anything still held is answered so the session is usable afterwards.
if (release.length > 0 && !fs.existsSync(release)) answerOne();
await sleep(500);

const requests = allRequests();
const real = requests.filter((turn) => !turn.suggestion);
note('summary', 'what the model was shown, per turn', {
  baseTurns,
  turns: real.map((turn, index) => ({ turn: index + 1, at: turn.at, channels: turn.channels })),
  suggestionRequests: requests.length - real.length,
  assistantMessages: assistantMessages(),
  status: await status(),
});
note('paths', 'files the reader can open', {
  log: path.resolve(logPath),
  transcript: transcript.length > 0 ? path.resolve(transcript) : undefined,
  inbox: path.resolve(inbox),
});
process.exit(0);
