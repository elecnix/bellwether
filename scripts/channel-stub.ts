// A one-way Claude Code channel, small enough to read in one pass. Each line
// appended to CHANNEL_INBOX becomes one notifications/claude/channel event.
//
//   CHANNEL_INBOX=/tmp/inbox.txt node scripts/channel-stub.ts
//
// Claude Code starts this over stdio when .mcp.json names it and the session
// runs with --dangerously-load-development-channels server:<name>.
//
// The inbox is append-only and a cursor file counts the lines already sent, so
// a line written while the stub is reading cannot be lost or sent twice.
import fs from 'node:fs';
import process from 'node:process';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const inbox: string = process.env['CHANNEL_INBOX'] ?? '';
const source = process.env['CHANNEL_SOURCE'] ?? 'probe';
const cursor = `${inbox}.cursor`;
if (inbox.length === 0) throw new Error('CHANNEL_INBOX is required');

const mcp = new Server(
  { name: source, version: '0.0.1' },
  {
    capabilities: { experimental: { 'claude/channel': {} } },
    instructions: 'One-way probe events. Read each one; no reply is expected.',
  },
);

await mcp.connect(new StdioServerTransport());
process.stderr.write(`channel stub ${source} connected, watching ${inbox}\n`);

function sentSoFar(): number {
  try {
    return Number.parseInt(fs.readFileSync(cursor, 'utf8').trim(), 10) || 0;
  } catch {
    return 0;
  }
}

async function drain(): Promise<void> {
  let lines: string[];
  try {
    lines = fs.readFileSync(inbox, 'utf8').split('\n').filter((line) => line.trim().length > 0);
  } catch {
    return;
  }
  let sent = sentSoFar();
  // A truncated inbox (a fresh probe run) restarts the count rather than
  // swallowing new lines because the cursor outran the file.
  if (sent > lines.length) {
    sent = 0;
    fs.writeFileSync(cursor, '0');
  }
  while (sent < lines.length) {
    const line = lines[sent] ?? '';
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: { content: line, meta: { source, probe: 'phase0' } },
    });
    sent += 1;
    fs.writeFileSync(cursor, String(sent));
    process.stderr.write(`channel stub sent #${sent}: ${line}\n`);
  }
}

// A poll of a local file is the transport a probe needs. 200 ms is far below
// the settle times the probes measure, so it does not blur the timings.
setInterval(() => {
  void drain();
}, 200);
