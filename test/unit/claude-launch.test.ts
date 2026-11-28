// Tier 1: what a Claude Code server learns about the session that started it
// (issue #184). Claude Code starts its MCP servers before an interactive
// `--resume` picks a session, and a `/resume` inside a running session keeps
// the same servers, so CLAUDE_CODE_SESSION_ID names a session the person left.
// Claude Code keeps the session it shows now in sessions/<pid>.json under its
// config directory. Whether the server takes channel messages depends on the
// flags Claude Code started with, which the MCP handshake does not carry.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { currentClaudeSession, loadsBellwetherChannel } from '../../src/integrations/claude/launch.ts';

test('the session a Claude Code process shows now comes from its sessions file, and the environment only stands in for a missing one', (t) => {
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-launch-'));
  t.after(() => fs.rmSync(config, { recursive: true, force: true }));
  assert.equal(currentClaudeSession(config, 4242, 'fresh-at-start'), 'fresh-at-start', 'no file yet: the session id Claude Code started the server with');
  fs.mkdirSync(path.join(config, 'sessions'));
  fs.writeFileSync(path.join(config, 'sessions', '4242.json'), JSON.stringify({ pid: 4242, sessionId: 'resumed-0cd9', kind: 'interactive' }));
  assert.equal(currentClaudeSession(config, 4242, 'fresh-at-start'), 'resumed-0cd9', 'a resume moved the process to another session');
  fs.writeFileSync(path.join(config, 'sessions', '4242.json'), '{"pid":4242,');
  assert.equal(currentClaudeSession(config, 4242, 'fresh-at-start'), 'fresh-at-start', 'a file caught halfway through a write');
  assert.equal(currentClaudeSession(config, 7, 'fresh-at-start'), 'fresh-at-start', "another process's file says nothing about this one");
});

test('Claude Code loads the Bellwether server as a channel only when a channel flag names it', () => {
  const yes = [
    ['claude', '--dangerously-load-development-channels', 'plugin:bellwether@elecnix-plugins'],
    ['claude', '--dangerously-load-development-channels=server:bellwether', '--resume'],
    ['claude', '--channels', 'plugin:bellwether@elecnix-plugins'],
    ['claude', '--dangerously-load-development-channels', 'server:your-attention,server:bellwether'],
    ['claude', '--dangerously-load-development-channels', 'server:your-attention', 'plugin:bellwether@elecnix-plugins', '--', 'say ok'],
  ];
  const no = [
    ['claude', '--resume'],
    ['claude', '--mcp-config=bellwether.json'],
    ['claude', '--dangerously-load-development-channels', 'server:your-attention', '--resume', 'plugin:bellwether@x'],
    ['claude', '--channels', 'server:bellwether-old'],
    ['claude', '--', '--channels', 'server:bellwether'],
    [],
  ];
  for (const argv of yes) assert.equal(loadsBellwetherChannel(argv), true, argv.join(' '));
  for (const argv of no) assert.equal(loadsBellwetherChannel(argv), false, argv.join(' '));
});
