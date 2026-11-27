// The Bellwether tools, in one list, so the Pi extension and the Claude
// MCP channel server register exactly the same names and schemas.
import os from 'node:os';
import fs from 'node:fs';
import type { HerdrClient } from '../core/herdr-client.ts';
import { AGENT_KINDS, DEFAULT_MAX_DEPTH, spawnChild, type SpawnOptions } from '../core/spawn.ts';
import { removeChildFiles } from '../core/mcp-config.ts';
import { reportForCaller } from '../core/report.ts';
import { childById, readParent, updateChild } from '../core/registry.ts';
import { adoptPane } from '../core/adopt.ts';
import { LOCAL_HOST, hostOf, type ClientFor } from '../core/machine.ts';
import { spawnResume } from '../core/spawn-resume.ts';
import { promptChild } from '../core/send.ts';
import type { Watcher } from '../core/watcher.ts';
import type { CallerIdentity, ChildRecord, ReportStatus } from '../core/types.ts';

export interface ToolContext {
  /** The parent's own herdr. */
  client: HerdrClient;
  /** The herdr for a host: `local`, or a saved herdr machine. */
  clientFor?: ClientFor;
  parentId: string;
  watcher: Watcher;
}

function clientFor(ctx: ToolContext, host: string): Promise<HerdrClient> {
  if (ctx.clientFor) return ctx.clientFor(host);
  return host === LOCAL_HOST ? Promise.resolve(ctx.client) : Promise.reject(new Error(`This session cannot reach herdr machine ${host}.`));
}

const MACHINE_DESCRIPTION = 'A saved herdr machine, by label or id as `herdr machine list` shows it. Omit it for this machine. A child on another machine cannot call parent_report, because its report lands on that machine\'s disk, so Bellwether follows it through herdr status alone.';

export interface ToolDefinition {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

const optionalString = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

/** The tools any session gets. */
export const parentTools: ToolDefinition[] = [
  {
    name: 'agent_spawn',
    description: 'Start a child coding agent in its own herdr tab, of any kind herdr can start. Bellwether watches it and starts your next turn when it reports, goes idle, blocks, stalls or exits. Give the prompt a concrete deliverable, and tell the child to call parent_report when it is done. With resume, the call is a message to an earlier child instead: a child herdr still shows gets the prompt as an ordinary message, with no new tab, and a retired one comes back in a new tab with its harness reopening the same session, under the same child id, so its history and unread events continue. Resume works for claude and pi children.',
    schema: {
      type: 'object',
      properties: {
        resume: { type: 'string', description: 'Message an earlier child rather than start a new one: its name, its id, or its session id. herdr decides whether it is alive. A session id no child of this session ran also takes kind, name, cwd and machine, and comes back as a new child. Omit it to start a new child.' },
        kind: { type: 'string', enum: [...AGENT_KINDS], description: 'The harness to start: pi, claude, codex, opencode or cline. Required without resume.' },
        name: { type: 'string', description: 'A short handle for the child, unique in this session. Used as the herdr agent name and the tab label. Required without resume.' },
        cwd: { type: 'string', description: 'The directory to start the child in. Use an absolute path, ideally a git worktree of its own.' },
        prompt: { type: 'string', description: 'The first message the child receives, or with resume the message for the earlier child. The whole prompt, not a path. Line breaks and any length are fine: Bellwether hands a new or resumed child the prompt through a private file.' },
        model: { type: 'string', description: 'The model or tier to pass to the child harness.' },
        args: { type: 'array', items: { type: 'string' }, description: 'Extra arguments for the child harness, passed through unchanged and appended last.' },
        focus: { type: 'boolean', description: 'Move your view to the new tab. Defaults to false, so the child does not steal focus.' },
        stuck_minutes: { type: 'number', description: 'How long the child may be quiet before it counts as stuck. Defaults to 10.' },
        inactive_minutes: { type: 'number', description: 'How long the child may show no activity of any kind, blocked included, before you are told. Defaults to 5. Clamped to between 1 and 1440. It cannot be turned off.' },
        max_depth: { type: 'number', description: 'How deep children may spawn children. Defaults to 2.' },
        machine: { type: 'string', description: `${MACHINE_DESCRIPTION} With resume, a known child always goes back to its own machine.` },
      },
    },
  },
  {
    name: 'agent_adopt',
    description: 'Make a running agent that this session did not start into its child, such as one herdr-spawn.sh or a person started. Bellwether then watches it like a spawned child. Refuses a pane another session already watches, and a pane with no agent herdr recognizes. An adopted child has no BELLWETHER_PARENT, so it cannot call parent_report.',
    schema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'The pane id, or the herdr name of the live agent.' },
        name: { type: 'string', description: 'The handle to use for the child. Defaults to its herdr name.' },
        machine: { type: 'string', description: MACHINE_DESCRIPTION },
        stuck_minutes: { type: 'number', description: 'How long the child may be quiet before it counts as stuck. Defaults to 10.' },
      },
      required: ['target'],
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
  return `${child.name}\t${child.kind}\t${state}\t${age}s\t${hostOf(child)}\t${child.paneId}\tunread ${unread}\t${child.cwd ?? ''}`;
}

/**
 * Run one tool for a session. `caller` is the identity the session's adapter
 * sent with the call; parent_report routes by it and by the child records
 * this daemon holds, never by the daemon's own environment.
 */
export async function runBellwetherTool(ctx: ToolContext, name: string, args: Record<string, unknown>, caller: CallerIdentity = {}): Promise<string> {
  if (name === 'parent_report') {
    const status = optionalString(args['status']) as ReportStatus | undefined;
    const text = optionalString(args['text']);
    if (!status || !text) throw new Error('parent_report needs both status and text');
    const written = reportForCaller(caller, status, text);
    return `Reported ${status} to the parent, as ${written.childName}.`;
  }

  const record = readParent(ctx.parentId);
  if (!record) throw new Error(`No Bellwether registry for ${ctx.parentId}. Start a session with the Bellwether extension loaded.`);

  if (name === 'agent_spawn' && optionalString(args['resume'])) {
    const result = await spawnResume((host) => clientFor(ctx, host), ctx.parentId, {
      target: optionalString(args['resume']) ?? '',
      prompt: optionalString(args['prompt']),
      kind: optionalString(args['kind']),
      name: optionalString(args['name']),
      cwd: optionalString(args['cwd']),
      host: optionalString(args['machine']),
      model: optionalString(args['model']),
      args: Array.isArray(args['args']) ? (args['args'] as string[]) : undefined,
      focus: args['focus'] === true,
    });
    const { child } = result;
    const lines = result.corrected ? [result.corrected] : [];
    if (result.action === 'messaged') {
      if (result.corrected) ctx.watcher.reset(child.id);
      lines.push(`${child.name} is still alive in pane ${child.paneId}, so the prompt went to it as a message, with no new tab.`, result.reply, `herdr link: ${result.link}`);
      return lines.join('\n');
    }
    ctx.watcher.reset(child.id);
    const where = child.host === LOCAL_HOST ? '' : ` on machine ${child.host}`;
    lines.push(`${child.name} resumed session ${result.session.value}${where} in pane ${child.paneId}, as the same child ${child.id}.`, 'Bellwether watches it again, and its earlier events and receipts carry on.', `herdr link: ${result.link}`);
    return lines.join('\n');
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
      inactiveMinutes: typeof args['inactive_minutes'] === 'number' ? (args['inactive_minutes'] as number) : undefined,
      maxDepth: typeof args['max_depth'] === 'number' ? (args['max_depth'] as number) : DEFAULT_MAX_DEPTH,
      host: optionalString(args['machine']) ?? LOCAL_HOST,
    };
    if (!optionalString(args['kind'])) throw new Error('agent_spawn needs a kind for a new child, or resume to message an earlier one.');
    if (!options.name) throw new Error('agent_spawn needs a name for a new child, or resume to message an earlier one.');
    // Resolve the machine before anything is written, so a typo leaves no record.
    const client = await clientFor(ctx, options.host ?? LOCAL_HOST);
    const { child, link } = await spawnChild(client, record, options, undefined, { forget: (childId) => ctx.watcher.forget(childId) });
    const where = child.host === LOCAL_HOST ? '' : ` on machine ${child.host}`;
    const lines = [`${child.name} started as a ${child.kind} agent${where} in pane ${child.paneId}, tab ${child.tabId ?? child.paneId}.`, `Bellwether watches it, and your next turn starts when it changes state.`, `herdr link: ${link}`];
    return lines.join('\n');
  }

  if (name === 'agent_adopt') {
    const target = optionalString(args['target']);
    if (!target) throw new Error('agent_adopt needs a target: a pane id or a live agent name');
    const host = optionalString(args['machine']) ?? LOCAL_HOST;
    const client = await clientFor(ctx, host);
    const { child, link, already } = await adoptPane(client, record, { target, host, name: optionalString(args['name']), stuckMinutes: typeof args['stuck_minutes'] === 'number' ? (args['stuck_minutes'] as number) : undefined });
    if (already) return `${child.name} in pane ${child.paneId} is already a child of this session.`;
    const where = host === LOCAL_HOST ? '' : ` on machine ${host}`;
    return [`Adopted ${child.name}, a ${child.kind} agent${where} in pane ${child.paneId}. Bellwether watches it from now on.`, 'It was not started by Bellwether, so it cannot call parent_report; its status changes still start your turns.', `herdr link: ${link}`].join('\n');
  }

  if (name === 'agent_list') {
    if (!record.children.length) return 'No children yet. Start one with agent_spawn.';
    const header = 'name\tkind\tstate\tage\thost\tpane\tunread\tcwd';
    return [header, ...record.children.map((child) => describeChild(child, ctx.watcher))].join('\n');
  }

  const target = optionalString(args['child']);
  if (!target) throw new Error(`${name} needs a child`);
  const child = resolve(record, target);
  if (!child) throw new Error(`No child of this session matches "${target}". Call agent_list to see them.`);
  // Pane ids are scoped to one herdr server, so every call goes to the child's host.
  const herdr = await clientFor(ctx, hostOf(child));

  if (name === 'agent_read') {
    const lines = typeof args['lines'] === 'number' ? (args['lines'] as number) : undefined;
    if (lines) return (await herdr.paneRead({ paneId: child.paneId, source: 'recent_unwrapped', lines })).trim();
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
    return (await herdr.paneRead({ paneId: child.paneId, source: 'recent_unwrapped', lines: 40 })).trim();
  }

  if (name === 'agent_send') {
    const text = optionalString(args['text']);
    const keys = Array.isArray(args['keys']) ? (args['keys'] as string[]) : undefined;
    if (keys?.length) {
      await herdr.sendKeys(child.paneId, keys);
      return `Sent ${keys.join(' ')} to ${child.name}.`;
    }
    if (!text) throw new Error('agent_send needs text or keys');
    return promptChild(herdr, child, text);
  }

  if (name === 'agent_stop') {
    if (!args['force'] && (child.lastStatus === 'working' || child.lastStatus === 'blocked')) {
      const tail = await herdr.paneRead({ paneId: child.paneId, source: 'recent_unwrapped', lines: 20 }).catch(() => '');
      return `${child.name} is ${child.lastStatus}, so agent_stop refused to close it. Pass force to close it anyway.\n${tail.trim()}`;
    }
    if (child.tabId) await herdr.tabClose(child.tabId);
    else await herdr.paneClose(child.paneId);
    updateChild(ctx.parentId, child.id, (entry) => {
      entry.exitedAt = new Date().toISOString();
    });
    removeChildFiles(child.id);
    return `Closed ${child.name}.`;
  }

  throw new Error(`Bellwether has no tool named ${name}`);
}

export function hostEnv(): Record<string, string> {
  return { host: os.hostname() };
}
