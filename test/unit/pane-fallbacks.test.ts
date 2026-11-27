// Tier 1: the API-first rule in AGENTS.md. A pane is a rendering of a child's
// state, not the state, so Bellwether reads or types into one only as a last
// resort. Every pane read and every keystroke in src/ and bin/ must sit under
// a comment that says which kind it is: `TODO(api):` for a fallback, naming the
// API that would retire it, or `Pane feature:` for a read a person asked to see
// or keys a parent chose to send. These cases fail when a new call has neither,
// and when code reaches herdr's pane methods without the HerdrClient wrappers
// this scan looks for.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SCANNED = ['src', 'bin'];
/** The file that defines the wrappers, and so the only one that names the raw methods. */
const CLIENT = path.join('src', 'core', 'herdr-client.ts');

/**
 * HerdrClient calls that read a pane's screen or type into it. agentPrompt
 * types a parent's message into the child's input box, so it counts too: the
 * session path in src/core/send.ts is the API, and typing is its fallback.
 */
const PANE_CALL = /\.(paneRead|sendKeys|sendInput|agentPrompt)\(/;
/** herdr methods and subscriptions that read a screen or send input, which only the client may name. */
const RAW_PANE_METHOD = /['"](pane\.(read|send_text|send_keys|send_input|wait_for_output|output_matched|run|selection\.read)|agent\.(read|send_keys|prompt))['"]/;
const TODO = /TODO\(api\):\s*(.*)/;
const FEATURE = /Pane feature:\s*(.*)/;
/** A TODO shorter than this cannot name an API and what it would replace. */
const MIN_REASON = 30;

interface PaneCall {
  file: string;
  line: number;
  call: string;
  kind: 'fallback' | 'feature' | 'unmarked';
  reason: string;
}

function isComment(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

/**
 * The comment block that annotates the statement holding line `index`: a
 * trailing comment on that line, or the comment lines just above the
 * statement, walking up through its earlier lines.
 */
function annotation(lines: string[], index: number): string {
  const own = lines[index] ?? '';
  const trailing = own.indexOf('//');
  const parts: string[] = trailing >= 0 ? [own.slice(trailing)] : [];
  let seenComment = false;
  for (let at = index - 1; at >= 0; at -= 1) {
    const line = lines[at] ?? '';
    if (isComment(line)) {
      seenComment = true;
      parts.unshift(line.trim());
      continue;
    }
    if (seenComment) break;
    const trimmed = line.trim();
    if (trimmed === '' || /[;{}]$/.test(trimmed)) break;
  }
  return parts.join(' ');
}

/** Every pane read and keystroke in one source file, with the comment that classifies it. */
function scanSource(file: string, source: string): PaneCall[] {
  const lines = source.split('\n');
  const found: PaneCall[] = [];
  lines.forEach((line, index) => {
    if (isComment(line)) return;
    const match = PANE_CALL.exec(line);
    if (!match) return;
    // The wrapper definitions themselves, not calls.
    if (file === CLIENT && /^\s*(async\s+)?(paneRead|sendKeys|sendInput|agentPrompt)\(/.test(line)) return;
    const note = annotation(lines, index);
    const todo = TODO.exec(note);
    const feature = FEATURE.exec(note);
    const kind = todo ? 'fallback' : feature ? 'feature' : 'unmarked';
    found.push({ file, line: index + 1, call: match[1] ?? '', kind, reason: (todo?.[1] ?? feature?.[1] ?? '').trim() });
  });
  return found;
}

function sourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const relative = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(relative);
      else if (/\.(ts|js|mjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) files.push(relative);
    }
  };
  for (const dir of SCANNED) walk(dir);
  return files;
}

function scanAll(): PaneCall[] {
  return sourceFiles().flatMap((file) => scanSource(file, fs.readFileSync(path.join(ROOT, file), 'utf8')));
}

test('the scan flags a new pane keystroke that has no TODO(api) or Pane feature comment', () => {
  const source = ['async function nudge(client) {', '  await client.sendKeys(paneId, ["Enter"]);', '}'].join('\n');
  assert.deepEqual(
    scanSource('src/example.ts', source).map((call) => call.kind),
    ['unmarked'],
  );
  const marked = ['async function nudge(client) {', '  // TODO(api): a herdr method that submits the dialog would replace this key.', '  await client.sendKeys(paneId, ["Enter"]);', '}'].join('\n');
  assert.deepEqual(
    scanSource('src/example.ts', marked).map((call) => call.kind),
    ['fallback'],
  );
});

test('a parent message typed through agent.prompt needs a TODO(api) comment, because the session path is the API', () => {
  const source = ['async function tell(herdr) {', '  await herdr.agentPrompt(paneId, text);', '}'].join('\n');
  assert.deepEqual(
    scanSource('src/example.ts', source).map((call) => call.kind),
    ['unmarked'],
  );
  const send = scanAll().filter((call) => call.file === path.join('src', 'core', 'send.ts') && call.call === 'agentPrompt');
  // A parent's message is typed as the session path's fallback. A start's
  // brief is typed as a feature: the parent asked for it, and the person
  // watching the pane reads the task (issue #162).
  assert.deepEqual(
    send.map((call) => call.kind),
    ['feature', 'fallback'],
    'src/core/send.ts types a start\'s brief in one place and a parent\'s message in another',
  );
});

test('a comment above one statement does not cover the next one', () => {
  const source = ['// Pane feature: the parent asked for the screen.', 'const a = await client.paneRead({ paneId });', 'const b = await client.paneRead({ paneId });'].join('\n');
  assert.deepEqual(
    scanSource('src/example.ts', source).map((call) => call.kind),
    ['feature', 'unmarked'],
  );
});

test('every pane read and keystroke is marked as a fallback with its API, or as a feature', () => {
  const calls = scanAll();
  assert.ok(calls.length > 0, 'the scan found no pane calls, so it no longer matches how the code reaches herdr');
  const unmarked = calls.filter((call) => call.kind === 'unmarked');
  assert.deepEqual(
    unmarked.map((call) => `${call.file}:${call.line} ${call.call}`),
    [],
    'add a TODO(api): comment naming the API that would replace each fallback, or a Pane feature: comment saying who asked for it (AGENTS.md, "Use an API before the pane")',
  );
  for (const call of calls.filter((entry) => entry.kind === 'fallback')) {
    assert.ok(call.reason.length >= MIN_REASON, `${call.file}:${call.line}: the TODO(api) comment must name the API or API change that would retire the fallback`);
  }
});

test('only the herdr client names the pane read and input methods', () => {
  const offenders = sourceFiles()
    .filter((file) => file !== CLIENT)
    .flatMap((file) =>
      fs
        .readFileSync(path.join(ROOT, file), 'utf8')
        .split('\n')
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => RAW_PANE_METHOD.test(line))
        .map(({ index }) => `${file}:${index + 1}`),
    );
  assert.deepEqual(offenders, [], 'call HerdrClient.paneRead or HerdrClient.sendKeys, so the pane-call scan sees the call');
});
