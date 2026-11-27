import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { legalModel, legalProvider, redact, report, scanText, scanTree } from '../../scripts/fixture-identifiers.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SCRIPT = path.join(ROOT, 'scripts/fixture-identifiers.ts');

// A name that looks like a real provider or tier and belongs to nobody. It is built at run time,
// so this file never holds one in a provider position itself.
function privateLooking(): string {
  const letters = [...randomBytes(8)].map((byte) => String.fromCharCode(97 + (byte % 26))).join('');
  return `q${letters}-cloud`;
}

test('the fixtures in this repository name only public or synthetic providers and models', () => {
  const findings = scanTree(ROOT);
  assert.deepEqual(findings, [], findings.length > 0 ? report(findings) : '');
});

test('a fixture that names a private-looking provider, model or tier fails, at its line', () => {
  const name = privateLooking();
  const text = [
    'const ok = 1;',
    `const PARENT_MODEL = { provider: '${name}', id: '${name}-large' };`,
    `runTool({ tier: '${name}-tier' });`,
    `assert.deepEqual(args, ['--provider', '${name}', '--model', 'example-model']);`,
    `const settings = { enabledModels: ['${name}/deepseek-v4.1-flash'] };`,
  ].join('\n');
  const findings = scanText(text, 'test/unit/example.test.ts');
  assert.deepEqual(findings.map((f) => [f.line, f.kind]), [
    [2, 'provider'],
    [2, 'model'],
    [3, 'model'],
    [4, 'provider'],
    [5, 'model'],
  ]);
});

test('synthetic prefixes, the public providers, version shapes and public model paths pass', () => {
  for (const provider of ['example-cloud', 'Fake', 'test-provider', 'stub', 'MOCK-x', 'openrouter']) assert.ok(legalProvider(provider), provider);
  for (const model of ['example-large', 'stub-model', 'haiku', 'deepseek-v4.1-flash', '4.5', 'v2', 'openrouter/deepseek-v4.1-flash', 'example-cloud/stub-model']) {
    assert.ok(legalModel(model), model);
  }
  for (const value of ['acme', 'cheap-model', 'openrouter/cheap-model', 'scripted']) assert.ok(!legalModel(value), value);
});

test('a failing run prints the file, the line and a redacted form, never the value', () => {
  const name = privateLooking();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-fixture-ids-'));
  try {
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.mkdirSync(path.join(dir, 'test'));
    fs.copyFileSync(SCRIPT, path.join(dir, 'scripts/fixture-identifiers.ts'));
    fs.writeFileSync(path.join(dir, 'test/leak.test.ts'), `\nconst model = { provider: '${name}', id: 'example-large' };\n`);
    let output = '';
    let status = 0;
    try {
      execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(dir, 'scripts/fixture-identifiers.ts')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      const failed = error as { status: number; stdout: string; stderr: string };
      status = failed.status;
      output = failed.stdout + failed.stderr;
    }
    assert.equal(status, 1, 'the check exits non-zero');
    assert.ok(output.includes(`test/leak.test.ts:2: provider ${redact(name)}`), output);
    assert.ok(!output.includes(name), 'the output must not carry the value');
    assert.ok(!output.includes(name.slice(1, -1)), 'nor any long piece of it');
    assert.match(output, /Use a synthetic provider or model id/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('redaction keeps the first and last character and the length', () => {
  assert.equal(redact('abcdef'), 'a****f (6 chars)');
  assert.equal(redact('ab'), '** (2 chars)');
});
