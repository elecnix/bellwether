// The six Bellwether tools, in one list, so the Pi extension and the Claude
// MCP channel server register exactly the same names and schemas.
import os from 'node:os';
import fs from 'node:fs';
import type { HerdrClient } from '../core/herdr-client.ts';
import { HerdrApiError } from '../core/herdr-client.ts';
import { AGENT_KINDS, DEFAULT_MAX_DEPTH, spawnChild, type SpawnOptions } from '../core/spawn.ts';
import { reportToParent } from '../core/report.ts';
import { childById, readParent, updateChild } from '../core/registry.ts';
import type { Watcher } from '../core/watcher.ts';
import type { ChildRecord, ReportStatus } from '../core/types.ts';

export interface ToolContext {
  client: HerdrClient;
  parentId: string;
  watcher: Watcher;
}

export interface ToolDefinition {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

const optionalString = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

/** The five tools any session gets. */
export const parentTools: ToolDefinition[] = [
  {
    name: 'agent_spawn',
    description: 'Start a child coding agent in its own herdr tab, of any kind herdr can start. Bellwether watches it and starts your next turn when it reports, goes idle, blocks, stalls or exits. Give the prompt a concrete deliverable, and tell the child to call parent_report when it is done.',
    schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: [...AGENT_KINDS], description: 'The harness to start: pi, claude, codex, opencode or cline.' },
        name: { type: 'string', description: 'A short handle for the child, unique in this session. Used as the herdr agent name and the tab label.' },
        cwd: { type: 'string', description: 'The directory to start the child in. Use an absolute path, ideally a git worktree of its own.' },
        prompt: { type: 'string', description: 'The first message the child receives. The whole prompt, not a path.' },
        model: { type: 'string', description: 'The model or tier to pass to the child harness.' },
        args: { type: 'array', items: { type: 'string' }, description: 'Extra arguments for the child harness, passed through unchanged and appended last.' },
        focus: { type: 'boolean', description: 'Move your view to the new tab. Defaults to false, so the child does not steal focus.' },
        stuck_minutes: { type: 'number', description: 'How long the child may be quiet before it counts as stuck. Defaults to 10.' },
        max_depth: { type: 'number', description: 'How deep children may spawn children. Defaults to 2.' },
      },
      required: ['kind', 'name'],
    },
  },
  {
    name: 'agent_list',
    description: 'List this session\'s children with status, age and unread events.',
    schema: { type: 'object', properties: {} },
  },
  {
    name: 'agent_read',
    description: 'Read a child: its last assistant message by default, or its screen when you pass lines.',
    schema: {
      type: 'object',
      properties: {
        child: { type: 'string', description: 'The child\'s name, its pane id, or the id agent_spawn returned.' },
        lines: { type: 'number', description: 'Read this many screen lines instead of the last message.' },
      },
      required: ['child'],
    },
  },
  {
    name: 'agent_send',
    description: 'Prompt a child with herdr agent.prompt. herdr refuses a blocked child, so for one this returns the dialog and takes keys to answer it instead.',
    schema: {
      type: 'object',
      properties: {
        child: { type: 'string', description: 'The child\'s name, its pane id, or the id agent_spawn returned.' },
        text: { type: 'string', description: 'The prompt to submit.' },
        keys: { type: 'array', items: { type: 'string' }, description: 'Key presses to send instead of a prompt, named as ctrl+c or enter.' },
      },
      required: ['child'],
    },
  },
  {
    name: 'agent_stop',
    description: 'Close a child\'s tab, which ends it. Refuses a working child unless you pass force.',
    schema: {
      type: 'object',
      properties: {
        child: { type: 'string', description: 'The child\'s name, its pane id, or the id agent_spawn returned.' },
        force: { type: 'boolean', description: 'Close the tab even while the child is working or blocked.' },
      },
      required: ['child'],
    },
  },
];

/** The one tool a child gets, when its environment names a parent. */
export const childTools: ToolDefinition[] = [
  {
    name: 'parent_report',
    description: 'Tell the parent session what happened. Call it when the task is done, when you need input to continue, or to report progress on a long task.',
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['done', 'needs-input', 'progress'], description: 'done finishes the task, needs-input asks a question, progress is a status note.' },
        text: { type: 'string', description: 'What to tell the parent. For done, the result. For needs-input, the question and the options you weighed.' },
      },
      required: ['status', 'text'],
    },
  },
];

export function toolSchema(name: string): Record<string, unknown> | undefined {
  return [...parentTools, ...childTools].find((tool) => tool.name === name)?.schema;
}

function resolve(record: ReturnType<typeof readParent>, child: string): ChildRecord | undefined {
  return record ? childById(record, child) : undefined;
}

function describeChild(child: ChildRecord, watcher: Watcher): string {
  const unread = watcher.outboxEntries().filter((entry) => !entry.read && entry.childId === child.id).length;
  const age = Math.max(0, Math.round((Date.now() - Date.parse(child.startedAt)) / 1000));
  const state = child.exitedAt ? `exited${child.exitCode === undefined ? '' : ` (${child.exitCode})`}` : child.lastStatus;
  return `${child.name}\t${child.kind}\t${state}\t${age}s\t${child.paneId}\tunread ${unread}\t${child.cwd ?? ''}`;
}

export async function runBellwetherTool(ctx: ToolContext, name: string, args: Record<string, unknown>): Promise<string> {
  const record = readParent(ctx.parentId);
  if (!record) throw new Error(`No Bellwether registry for ${ctx.parentId}. Start a session with the Bellwether extension loaded.`);

  if (name === 'parent_report') {
    const status = optionalString(args['status']) as ReportStatus | undefined;
    const text = optionalString(args['text']);
    if (!status || !text) throw new Error('parent_report needs both status and text');
    const written = reportToParent(status, text);
    if (!written) throw new Error('This session has no BELLWETHER_PARENT, so there is nobody to report to.');
    return `Reported ${status} to the parent.`;
  }

  if (name === 'agent_spawn') {
    const options: SpawnOptions = {
      kind: optionalString(args['kind']) ?? 'pi',
      name: optionalString(args['name']) ?? '',
      cwd: optionalString(args['cwd']),
      prompt: optionalString(args['prompt']),
      model: optionalString(args['model']),
      args: Array.isArray(args['args']) ? (args['args'] as string[]) : undefined,
      focus: args['focus'] === true,
      stuckMinutes: typeof args['stuck_minutes'] === 'number' ? (args['stuck_minutes'] as number) : undefined,
      maxDepth: typeof args['max_depth'] === 'number' ? (args['max_depth'] as number) : DEFAULT_MAX_DEPTH,
    };
    if (!options.name) throw new Error('agent_spawn needs a name');
    const { child, link } = await spawnChild(ctx.client, record, options);
    return [`${child.name} started as a ${child.kind} agent in pane ${child.paneId}, tab ${child.tabId ?? child.paneId}.`, `Bellwether watches it, and your next turn starts when it changes state.`, `herdr link: ${link}`].join('\n');
  }

  if (name === 'agent_list') {
    if (!record.children.length) return 'No children yet. Start one with agent_spawn.';
    const header = 'name\tkind\tstate\tage\tpane\tunread\tcwd';
    return [header, ...record.children.map((child) => describeChild(child, ctx.watcher))].join('\n');
  }

  const target = optionalString(args['child']);
  if (!target) throw new Error(`${name} needs a child`);
  const child = resolve(record, target);
  if (!child) throw new Error(`No child of this session matches "${target}". Call agent_list to see them.`);

  if (name === 'agent_read') {
    const lines = typeof args['lines'] === 'number' ? (args['lines'] as number) : undefined;
    if (lines) return (await ctx.client.paneRead({ paneId: child.paneId, source: 'recent_unwrapped', lines })).trim();
    if (child.transcript) {
      try {
        const content = fs.readFileSync(child.transcript, 'utf8');
        const messages = content
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            try {
              return JSON.parse(line) as Record<string, unknown>;
            } catch {
              return undefined;
            }
          })
          .filter((entry): entry is Record<string, unknown> => entry !== undefined);
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          const entry = messages[index] as Record<string, unknown>;
          const message = entry['message'];
          const role = entry['type'] === 'assistant' ? 'assistant' : typeof message === 'object' && message !== null ? (message as Record<string, unknown>)['role'] : undefined;
          if (role !== 'assistant') continue;
          const body = typeof message === 'object' && message !== null ? (message as Record<string, unknown>)['content'] : entry['content'];
          const text = typeof body === 'string' ? body : Array.isArray(body) ? body.map((part) => (typeof part === 'object' && part !== null && typeof (part as Record<string, unknown>)['text'] === 'string' ? String((part as Record<string, unknown>)['text']) : '')).filter(Boolean).join('\n') : '';
          if (text.trim()) return text;
        }
      } catch {
        // Fall through to the screen.
      }
    }
    return (await ctx.client.paneRead({ paneId: child.paneId, source: 'recent_unwrapped', lines: 40 })).trim();
  }

  if (name === 'agent_send') {
    const text = optionalString(args['text']);
    const keys = Array.isArray(args['keys']) ? (args['keys'] as string[]) : undefined;
    if (keys?.length) {
      await ctx.client.sendKeys(child.paneId, keys);
      return `Sent ${keys.join(' ')} to ${child.name}.`;
    }
    if (!text) throw new Error('agent_send needs text or keys');
    try {
      await ctx.client.agentPrompt(child.paneId, text);
      return `Prompted ${child.name}.`;
    } catch (error) {
      if (error instanceof HerdrApiError && child.lastStatus === 'blocked') {
        const dialog = await ctx.client.paneRead({ paneId: child.paneId, source: 'detection', lines: 30 }).catch(() => '');
        return `herdr refused the prompt because ${child.name} is blocked. The dialog:\n${dialog.trim()}\n\nReply with agent_send keys, for example ["enter"] or ["down","enter"].`;
      }
      throw error;
    }
  }

  if (name === 'agent_stop') {
    if (!args['force'] && (child.lastStatus === 'working' || child.lastStatus === 'blocked')) {
      const tail = await ctx.client.paneRead({ paneId: child.paneId, source: 'recent_unwrapped', lines: 20 }).catch(() => '');
      return `${child.name} is ${child.lastStatus}, so agent_stop refused to close it. Pass force to close it anyway.\n${tail.trim()}`;
    }
    if (child.tabId) await ctx.client.tabClose(child.tabId);
    else await ctx.client.paneClose(child.paneId);
    updateChild(ctx.parentId, child.id, (entry) => {
      entry.exitedAt = new Date().toISOString();
    });
    return `Closed ${child.name}.`;
  }

  throw new Error(`Bellwether has no tool named ${name}`);
}

export function hostEnv(): Record<string, string> {
  return { host: os.hostname() };
}
