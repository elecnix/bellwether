// The receipt scan. Claude Code writes one JSONL line per event to
// ~/.claude/projects/<slug>/<session>.jsonl. A channel notification lands
// there as an attachment whose origin is the channel once the model receives
// it. An entry counts as read when its receipt id appears in such a line from
// this server. The same id in a tool result, which is what a parent that reads
// its outbox file from a shell produces, or in a line that only queues the
// notice, is not a delivery.
import fs from 'node:fs';
import path from 'node:path';
import { claudeConfigDir, claudeProjectDir } from '../../core/transcript.ts';

export { claudeConfigDir };

export function findTranscript(session: string, cwd?: string, configDir?: string): string | undefined {
  const root = path.join(configDir ?? claudeConfigDir(), 'projects');
  if (cwd) {
    const direct = path.join(root, claudeProjectDir(cwd), `${session}.jsonl`);
    if (fs.existsSync(direct)) return direct;
  }
  try {
    for (const dir of fs.readdirSync(root)) {
      const file = path.join(root, dir, `${session}.jsonl`);
      if (fs.existsSync(file)) return file;
    }
  } catch {
    // A missing projects directory is not an error: the scan simply waits.
  }
  return undefined;
}

/** Read a byte range in pieces, so a long session log never sits in memory whole. */
function readRange(file: string, from: number, to: number): string {
  const pieces: string[] = [];
  const fd = fs.openSync(file, 'r');
  try {
    const size = 4 * 1024 * 1024;
    let at = from;
    while (at < to) {
      const length = Math.min(size, to - at);
      const buffer = Buffer.alloc(length);
      const read = fs.readSync(fd, buffer, 0, length, at);
      if (read <= 0) break;
      pieces.push(buffer.toString('utf8', 0, read));
      at += read;
    }
  } finally {
    fs.closeSync(fd);
  }
  return pieces.join('');
}

/** Whether a channel server name is this server, under its own name or as a plugin's copy. */
function isBellwether(server: unknown): boolean {
  return typeof server === 'string' && (server === 'bellwether' || server.endsWith(':bellwether'));
}

/**
 * The text of one transcript line when it records a Bellwether channel
 * message reaching the model, or undefined for any other line.
 */
export function deliveredText(line: string): string | undefined {
  if (!line.includes('channel')) return undefined;
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (record['type'] === 'queue-operation') return undefined;
  const attachment = record['attachment'] as Record<string, unknown> | undefined;
  const message = record['message'] as Record<string, unknown> | undefined;
  const origin = (attachment?.['origin'] ?? record['origin'] ?? message?.['origin']) as Record<string, unknown> | undefined;
  if (origin?.['kind'] !== 'channel' || !isBellwether(origin['server'])) return undefined;
  return line;
}

/** The receipts that appear in delivery lines of a stretch of complete transcript lines. */
function deliveredReceipts(content: string, wanted: readonly string[]): Set<string> {
  const found = new Set<string>();
  for (const line of content.split('\n')) {
    const text = deliveredText(line);
    if (!text) continue;
    for (const receipt of wanted) if (text.includes(receipt)) found.add(receipt);
  }
  return found;
}

/** The length of the part of a chunk that ends with a whole line. */
function wholeLines(content: string): number {
  return content.lastIndexOf('\n') + 1;
}

/**
 * Incremental reader over one transcript. The offset starts at the file size
 * when the server connects, so only later bytes count: a receipt id from an
 * earlier run of the same session must not mark a new entry read.
 */
export class ReceiptScan {
  private readonly session: string;
  private readonly cwd: string | undefined;
  private readonly configDir: string | undefined;
  private transcript: string | undefined;
  private offset = 0;

  constructor(session: string, cwd?: string, configDir?: string) {
    this.session = session;
    this.cwd = cwd;
    this.configDir = configDir;
  }

  /** Anchor at the current end of the transcript, wherever it is. */
  start(): void {
    this.transcript = findTranscript(this.session, this.cwd, this.configDir);
    if (!this.transcript) return;
    try {
      this.offset = fs.statSync(this.transcript).size;
    } catch {
      this.offset = 0;
    }
  }

  /**
   * Receipts a channel delivery already brought into the file. Run once at
   * startup, so an event the previous server delivered is not pushed again.
   */
  search(receipts: Iterable<string>): Set<string> {
    const found = new Set<string>();
    const wanted = [...receipts];
    if (!wanted.length) return found;
    const file = this.transcript ?? findTranscript(this.session, this.cwd, this.configDir);
    if (!file) return found;
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return found;
    }
    if (size === 0) return found;
    return deliveredReceipts(readRange(file, 0, size), wanted);
  }

  /** The receipt ids that a channel delivery brought into the transcript since the last scan. */
  scan(receipts: Iterable<string>): Set<string> {
    const seen = new Set<string>();
    const wanted = [...receipts];
    if (!wanted.length) return seen;
    this.transcript ??= findTranscript(this.session, this.cwd, this.configDir);
    if (!this.transcript) return seen;
    let size: number;
    try {
      size = fs.statSync(this.transcript).size;
    } catch {
      return seen;
    }
    if (size <= this.offset) return seen;
    const added = readRange(this.transcript, this.offset, size);
    // A line Claude Code is still writing waits for the next look.
    const complete = wholeLines(added);
    this.offset += Buffer.byteLength(added.slice(0, complete), 'utf8');
    return deliveredReceipts(added.slice(0, complete), wanted);
  }
}
