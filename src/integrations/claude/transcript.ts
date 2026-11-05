// The receipt scan. Claude Code writes one JSONL line per event to
// ~/.claude/projects/<slug>/<session>.jsonl, and a channel notification lands
// there once the model receives it. An entry counts as read when its receipt
// id appears in the file, which is the same trick your-attention uses for its
// answers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeProjectDir } from '../../core/transcript.ts';

/** Claude Code's state root, which a lab overrides with CLAUDE_CONFIG_DIR. */
export function claudeConfigDir(): string {
  return process.env['CLAUDE_CONFIG_DIR'] ?? path.join(os.homedir(), '.claude');
}

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
   * Receipts already present anywhere in the file. Run once at startup, so an
   * event the previous server pushed is not pushed a second time.
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
    const content = readRange(file, 0, size);
    for (const receipt of wanted) if (content.includes(receipt)) found.add(receipt);
    return found;
  }

  /** The receipt ids that reached the transcript since the last scan. */
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
    this.offset = size;
    for (const receipt of wanted) if (added.includes(receipt)) seen.add(receipt);
    return seen;
  }
}
