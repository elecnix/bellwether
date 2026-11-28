// Tier 1: no code outside the harness registry branches on a harness's name.
// The spawn, resume, restart, the watcher, agent_read and the remote
// registration read a harness's entry in src/core/harnesses/, so adding a
// harness touches only the registry. A comparison of a kind or a harness name
// with a literal anywhere else fails here, unless it sits in one of the places
// listed below, each with the reason it is not about a child's harness.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SCANNED = ['src', 'bin'];
const REGISTRY = path.join('src', 'core', 'harnesses');
const NAMES = '(?:pi|claude|claude-code|opencode|codex|cline|kilo|omp)';
const COMPARISON = new RegExp(`(?:[!=]==?\\s*'${NAMES}'|'${NAMES}'\\s*[!=]==?)`);

/**
 * Files that compare against a harness name for a reason other than a
 * child's harness, with the lines that may. A line outside the pattern still
 * fails, so the exemption cannot grow by accident.
 */
const ALLOWED: Record<string, { lines: RegExp; why: string }> = {
  [path.join('src', 'daemon', 'protocol.ts')]: { lines: /harness !== 'pi' && harness !== 'claude-code'/, why: 'a parent session runs in pi or Claude Code, the two harnesses with a Bellwether adapter' },
  [path.join('src', 'core', 'restart.ts')]: { lines: /record\.harness|plan\.kind/, why: 'restarting a parent session, which runs in pi or Claude Code' },
  [path.join('src', 'core', 'move-plan.ts')]: { lines: /harness/, why: "agent_move's session layouts, for the harnesses whose entries say movable" },
  [path.join('src', 'core', 'session-state.ts')]: { lines: /harness/, why: "agent_move's session layouts, for the harnesses whose entries say movable" },
  [path.join('src', 'cli.ts')]: { lines: /harness === 'pi'/, why: "doctor's check of agent_move, for the harnesses whose entries say movable" },
};

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (rel !== REGISTRY) out.push(...sources(rel));
    } else if (/\.ts$/.test(entry.name)) out.push(rel);
  }
  return out;
}

test('no file outside the registry compares a kind or harness with a harness name', () => {
  const found: string[] = [];
  for (const file of SCANNED.flatMap(sources)) {
    const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) return;
      if (!COMPARISON.test(line)) return;
      if (ALLOWED[file]?.lines.test(line)) return;
      found.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(found, [], `these lines branch on a harness name; read the harness's entry from src/core/harnesses/ instead:\n${found.join('\n')}`);
});

test('each exemption still matches a line, so a stale one is removed', () => {
  for (const [file, { lines, why }] of Object.entries(ALLOWED)) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.ok(text.split('\n').some((line) => COMPARISON.test(line) && lines.test(line)), `${file} no longer needs its exemption (${why})`);
  }
});
