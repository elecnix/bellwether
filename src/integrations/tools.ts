// The Bellwether tools, in one list, so the Pi extension and the Claude
// MCP channel server register exactly the same names and schemas.
import os from 'node:os';
import type { HerdrClient } from '../core/herdr-client.ts';
import { AGENT_KINDS, spawnChild, type RegisterRemote, type SpawnOptions } from '../core/spawn.ts';
import { GRANT_DEPTH_TOOL, REQUEST_DEPTH_TOOL, ceilingOf, childCeiling, describeDepth, grantDepth, raiseTree, requestDepth } from '../core/depth.ts';
import { removeChildFiles } from '../core/mcp-config.ts';
import { PROMPT_NOTICE, notePromptForCaller, reportForCaller } from '../core/report.ts';
import { childById, mutateParent, readParent, updateChild } from '../core/registry.ts';
import { adoptPane } from '../core/adopt.ts';
import { LOCAL_HOST, hostOf, knownHosts, type ClientFor } from '../core/machine.ts';
import { spawnResume } from '../core/spawn-resume.ts';
import { promptChild } from '../core/send.ts';
import { RESTART_TOOL, runAgentRestart, type RestartHooks } from '../core/restart.ts';
import { RETIRE_TOOL, realRetireOps, requestRetirement, type RetireOps } from '../core/retire.ts';
import type { RemoteOps } from '../core/remote.ts';
import { lastAssistantMessage, locateTranscript } from '../core/transcript.ts';
import { moveChild } from '../core/move.ts';
import { parseWorkspaces, releaseWorkspace, workspaceColumn, workspaceName } from '../core/workspace.ts';
import { moveEndpoints, type EndpointFor } from '../core/move-endpoint.ts';
import type { Watcher } from '../core/watcher.ts';
import type { CallerIdentity, ChildRecord, RelayHostState, ReportStatus } from '../core/types.ts';

export interface ToolContext {
  /** The parent's own herdr. */
  client: HerdrClient;
  /** The herdr for a host: `local`, or a saved herdr machine. */
  clientFor?: ClientFor;
  parentId: string;
  watcher: Watcher;
  /** git, gh and the process table, for the retirement request. Tests pass a fake. */
  retireOps?: RetireOps;
  /** A child's machine: registering it there over SSH, and reading its transcript over the daemon's connection. */
  remote?: RemoteOps;
  /** How the daemon's connection to a remote host stands, so a list can say which hosts it is not hearing from. */
  relayState?: (host: string) => RelayHostState | undefined;
  /** How a restart is deferred, waited on and stopped. The daemon supplies it; a test passes its own. */
  restart?: RestartHooks;
  /** Each machine's side of a move: this one in process, another over SSH. Tests pass their own. */
  endpointFor?: EndpointFor;
  /** The hosts a child can run on, for a move that names no machine. */
  knownHosts?: () => Promise<string[]>;
  /** The daemon's log. */
  log?: (message: string) => void;
}

function clientFor(ctx: ToolContext, host: string): Promise<HerdrClient> {
  if (ctx.clientFor) return ctx.clientFor(host);
  return host === LOCAL_HOST ? Promise.resolve(ctx.client) : Promise.reject(new Error(`This session cannot reach herdr machine ${host}.`));
}

const MACHINE_DESCRIPTION = 'A saved herdr machine, by label or id as `herdr machine list` shows it. Omit it for this machine. A claude or pi child on another machine is registered there over SSH, and this machine\'s Bellwether daemon keeps an SSH connection open to it to collect its parent_report and read its transcript, so the machine needs Bellwether installed. That machine never connects back.';

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
        model: { type: 'string', description: 'The model or tier to pass to the child harness. A pi child needs provider with it; with neither, a pi child runs on the provider and model of this session.' },
        provider: { type: 'string', description: 'The pi provider for model. Pass both or neither.' },
        args: { type: 'array', items: { type: 'string' }, description: 'Extra arguments for the child harness, passed through unchanged and appended last.' },
        focus: { type: 'boolean', description: 'Move your view to the new tab. Defaults to false, so the child does not steal focus.' },
        stuck_minutes: { type: 'number', description: 'How long the child may be quiet before it counts as stuck. Defaults to 10.' },
        inactive_minutes: { type: 'number', description: 'How long the child may show no activity of any kind, blocked included, before you are told. Defaults to 5. Clamped to between 1 and 1440. It cannot be turned off.' },
        max_depth: { type: 'number', description: 'The deepest generation the child\'s own descendants may reach: with 2, your child may spawn children but they may not. Defaults to 2. From the session at the top of the tree, it also sets the tree\'s ceiling, which no grant goes past. From any other session, it is held to your own ceiling. A child in a workspace of its own counts the same depth as any other.' },
        machine: { type: 'string', description: `${MACHINE_DESCRIPTION} With resume, a known child always goes back to its own machine.` },
        workspace: { type: 'string', description: 'The herdr workspace for the child\'s tab. "new" creates a workspace for the child, on the child\'s machine, and starts the child in its first tab; the child\'s own children then open there too, so its subtree stays out of your workspace, and Bellwether closes that workspace once nothing is left in it. An existing workspace\'s id or label puts the child there, on the child\'s machine, and Bellwether never closes it; a name that matches nothing is refused. Omit it to open the child in your own workspace, as before.' },
        workspace_label: { type: 'string', description: 'The label of the workspace that workspace "new" creates. Defaults to the child\'s name.' },
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
    name: GRANT_DEPTH_TOOL,
    description: `Answer a child's ${REQUEST_DEPTH_TOOL}, which reaches you as a report: grant levels to raise its ceiling to its depth plus levels, or pass 0 to refuse, with no reason needed. Either way the child is told. A grant past your own ceiling goes on to your own parent with a line saying who asks and why, and lands when that parent grants; nobody can grant past the ceiling the top of the tree was given. Every grant goes on the child's record, with who granted it, when, how far and why, and agent_list shows it.`,
    schema: {
      type: 'object',
      properties: {
        child: { type: 'string', description: 'The child\'s name, its pane id, or the id agent_spawn returned.' },
        levels: { type: 'number', description: 'How many generations below the child to allow: 1 lets it spawn children, 2 lets those spawn too. 0 refuses.' },
        request: { type: 'string', description: 'The request id the report named. Defaults to the child\'s newest open request.' },
        reason: { type: 'string', description: 'Why, for the record, when you grant without a request. Defaults to the child\'s own reason.' },
      },
      required: ['child', 'levels'],
    },
  },
  {
    name: 'agent_move',
    description: 'Move a live claude or pi child to another machine, in either direction, keeping its child id, its name and its conversation: Bellwether copies the harness session to the other machine, checks the copy, closes the child\'s tab, and resumes the session there, and the parent dials the new machine for its reports from then on. If the child cannot start on the other machine, Bellwether starts it again where it was and says the move failed. It refuses, before touching anything: a different harness on the other machine (a session belongs to the harness that wrote it); a harness missing there, or older than the version that wrote the session, which could lose the conversation; a pi child whose provider and model pair the other machine does not offer; a working directory that does not exist there; a child that is working or blocked, because the move would cut its turn short; a child that has exited or has no recorded session; and a child another resume or move holds. It also stops, and removes the copy, when the copy does not read back with the same bytes and checksum. The working directory is not copied: the repository has to be on the other machine already.',
    schema: {
      type: 'object',
      properties: {
        child: { type: 'string', description: 'The child\'s name, its pane id, or the id agent_spawn returned.' },
        machine: { type: 'string', description: 'The machine to move to: a saved herdr machine by label or id, or local for this one. Omit it when exactly one other machine is known; with more, the call is refused as ambiguous.' },
        cwd: { type: 'string', description: 'The directory the child resumes in on the other machine. Defaults to the directory it runs in now, which must exist there.' },
        kind: { type: 'string', enum: ['claude', 'pi'], description: 'The harness to run on the other machine. Defaults to the child\'s own, and any other is refused.' },
        reason: { type: 'string', description: 'Why the child moves, kept in move.log.' },
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
  {
    name: RESTART_TOOL,
    description: 'Restart an agent in place of its session: a child by name, id or pane, another session by its parent id, session id or pane, or yourself when you omit the target. The daemon closes the old pane, then runs the same harness on the same session in a new tab, in the same directory, so the conversation continues and no pane is left over. A child keeps its child id, so its history, receipts and retire state continue. Restarting yourself returns first: the daemon acts once your turn ends, so finish your reply and say where you will land. It refuses a target with no session to name, one on another machine, a pane no registry holds, a parent pane that now holds another session, and a target that is still mid-turn when the wait runs out.',
    schema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'What to restart: a child name, id or pane, or a parent session id or pane. Omit it to restart this session.' },
        wait_seconds: { type: 'number', description: 'How long to wait for the target\'s turn to end before refusing. Defaults to 30, and is held under 45 so the call can still answer.' },
      },
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
  {
    name: REQUEST_DEPTH_TOOL,
    description: 'Ask your parent for a deeper ceiling, when agent_spawn refuses because the tree is as deep as it may go. The call returns at once with a request id: it is not a wait, so carry on with what you can do at your current depth. Your parent grants or refuses, or passes the request up the chain when it lacks the room, and you get a message with the answer either way.',
    schema: {
      type: 'object',
      properties: {
        levels: { type: 'number', description: 'How many generations below you the work needs: 1 to spawn children, 2 for them to spawn too.' },
        reason: { type: 'string', description: 'One sentence naming the work that needs the levels.' },
      },
      required: ['levels', 'reason'],
    },
  },
];

/** The tool a child Bellwether spawned gets, when its environment carries BELLWETHER_CHILD. */
export const retireTools: ToolDefinition[] = [
  {
    name: RETIRE_TOOL,
    description: 'Ask to be retired once you exit: the Bellwether daemon then removes your worktree and deletes your branch, but only after your pane and tab are gone, the worktree is not a main worktree, is clean and has no stash, the branch is merged or pushed with its pull request merged or closed, and no process works inside it. The call removes nothing. It runs the checks it can run now and says which pass, records the request, and leaves the rest to the daemon. Close your tab afterwards.',
    schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Why the work is finished, kept on your record and in the retire log.' },
      },
    },
  },
];

/**
 * The tools a session gets, from its environment: every session gets the
 * parent tools, a session with a parent also gets parent_report, and only a
 * session with a child id gets the retirement request.
 */
export function toolsFor(env: { parent?: string; child?: string }): ToolDefinition[] {
  return [...parentTools, ...(env.parent || env.child ? childTools : []), ...(env.child ? retireTools : [])];
}

/** A tool this install does not have. The daemon answers it with code unknown_tool, which a newer client names. */
export class UnknownTool extends Error {
  constructor(name: string) {
    super(`Bellwether has no tool named ${name}`);
    this.name = 'UnknownTool';
  }
}

/** Every tool this install has, by name. */
export function toolNames(): string[] {
  return [...parentTools, ...childTools, ...retireTools].map((tool) => tool.name);
}

/** Every call the daemon runs: the tools, and the notices an adapter sends that no model sees. */
export function daemonCallNames(): string[] {
  return [...toolNames(), PROMPT_NOTICE];
}

export function toolSchema(name: string): Record<string, unknown> | undefined {
  return [...parentTools, ...childTools, ...retireTools].find((tool) => tool.name === name)?.schema;
}

/**
 * The child a tool call names: by child id, by the name the parent gave it or
 * by pane, and failing those by the name the harness gave itself. Two children
 * that answer to the harness name are refused, never guessed between.
 */
function resolve(record: ReturnType<typeof readParent>, child: string): ChildRecord | undefined {
  if (!record) return undefined;
  const direct = childById(record, child);
  if (direct) return direct;
  const named = record.children.filter((entry) => entry.agentName === child);
  if (named.length > 1) throw new Error(`"${child}" is the name ${named.map((entry) => entry.name).join(' and ')} each gave themselves. Name the child by the name you gave it, or by its pane.`);
  return named[0];
}

/** A child's host, with a warning when the daemon is not hearing from that machine. */
function hostColumn(child: ChildRecord, relayState: ToolContext['relayState']): string {
  const host = hostOf(child);
  if (host === LOCAL_HOST || !relayState) return host;
  const state = relayState(host);
  if (!state) return child.exitedAt ? host : `${host} (no connection)`;
  if (state.status === 'connected') return host;
  return `${host} (not heard from: ${state.status}${state.lastError ? `, ${state.lastError}` : ''})`;
}

function describeChild(child: ChildRecord, watcher: Watcher, relayState?: ToolContext['relayState']): string {
  const unread = watcher.outboxEntries().filter((entry) => !entry.read && entry.childId === child.id).length;
  const age = Math.max(0, Math.round((Date.now() - Date.parse(child.startedAt)) / 1000));
  const restart = child.restartRequestedAt ? ', restart pending' : '';
  const retire = child.retireOutcome === 'removed' ? ', retired' : child.retireOutcome === 'refused' ? ', retirement refused' : child.retireRequestedAt ? ', retirement requested' : '';
  const state = `${child.exitedAt ? `exited${child.exitCode === undefined ? '' : ` (${child.exitCode})`}` : child.lastStatus}${restart}${retire}`;
  const name = child.agentName ? `${child.name} (${child.agentName})` : child.name;
  const kind = child.model ? `${child.kind} (${child.model.provider}/${child.model.id})` : child.kind;
  return `${name}\t${kind}\t${state}\t${age}s\t${hostColumn(child, relayState)}\t${workspaceColumn(child)}\t${child.paneId}\t${child.depth}/${ceilingOf(child)}\tunread ${unread}\t${child.cwd ?? ''}`;
}

/**
 * Run one tool for a session. `caller` is the identity the session's adapter
 * sent with the call; parent_report routes by it and by the child records
 * this daemon holds, never by the daemon's own environment.
 */
export async function runBellwetherTool(ctx: ToolContext, name: string, args: Record<string, unknown>, caller: CallerIdentity = {}): Promise<string> {
  // Checked first, so a tool from a newer client gets a refusal the client can name, not a complaint about its arguments.
  if (!daemonCallNames().includes(name)) throw new UnknownTool(name);
  if (name === 'parent_report') {
    const status = optionalString(args['status']) as ReportStatus | undefined;
    const text = optionalString(args['text']);
    if (!status || !text) throw new Error('parent_report needs both status and text');
    const written = reportForCaller(caller, status, text);
    return `Reported ${status} to the parent, as ${written.childName}.`;
  }

  if (name === PROMPT_NOTICE) {
    // Sent by a pi child's extension or a Claude Code child's hook, never offered to a model.
    const source = args['source'] === 'claude-code' ? 'claude-code' : 'pi';
    return notePromptForCaller(caller, { open: args['open'] === true, title: optionalString(args['title']), kind: optionalString(args['kind']), source });
  }

  if (name === REQUEST_DEPTH_TOOL) {
    // Routed by the caller's identity and this daemon's records, like parent_report.
    const levels = typeof args['levels'] === 'number' ? (args['levels'] as number) : Number.NaN;
    return requestDepth(caller, levels, optionalString(args['reason']) ?? '');
  }

  if (name === RETIRE_TOOL) {
    // Routed by the caller's identity and this daemon's records, like parent_report.
    return requestRetirement(caller, ctx.retireOps ?? realRetireOps(), optionalString(args['reason']));
  }

  if (name === RESTART_TOOL) {
    // Routed by the caller's identity and the records this daemon holds.
    return runAgentRestart(ctx.client, ctx.parentId, caller, { ...(ctx.restart ?? {}), reset: (childId) => ctx.watcher.reset(childId) }, optionalString(args['target']), typeof args['wait_seconds'] === 'number' ? (args['wait_seconds'] as number) : undefined);
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
      registerRemote: registrar(ctx, record),
      cleanupRemote: remoteCleanup(ctx),
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
    if (result.reportWarning) lines.push(result.reportWarning);
    return lines.join('\n');
  }

  if (name === 'agent_spawn') {
    const asked = typeof args['max_depth'] === 'number' ? (args['max_depth'] as number) : undefined;
    const depth = childCeiling(record, asked, caller);
    const options: SpawnOptions = {
      kind: optionalString(args['kind']) ?? 'pi',
      name: optionalString(args['name']) ?? '',
      cwd: optionalString(args['cwd']),
      prompt: optionalString(args['prompt']),
      model: optionalString(args['model']),
      provider: optionalString(args['provider']),
      parentModel: caller.model,
      args: Array.isArray(args['args']) ? (args['args'] as string[]) : undefined,
      focus: args['focus'] === true,
      stuckMinutes: typeof args['stuck_minutes'] === 'number' ? (args['stuck_minutes'] as number) : undefined,
      inactiveMinutes: typeof args['inactive_minutes'] === 'number' ? (args['inactive_minutes'] as number) : undefined,
      maxDepth: depth.ceiling,
      spawnerCeiling: depth.spawnerCeiling,
      host: optionalString(args['machine']) ?? LOCAL_HOST,
      workspace: optionalString(args['workspace']),
      workspaceLabel: optionalString(args['workspace_label']),
    };
    if (!optionalString(args['kind'])) throw new Error('agent_spawn needs a kind for a new child, or resume to message an earlier one.');
    if (!options.name) throw new Error('agent_spawn needs a name for a new child, or resume to message an earlier one.');
    // Resolve the machine before anything is written, so a typo leaves no record.
    const client = await clientFor(ctx, options.host ?? LOCAL_HOST);
    const { child, link, reportWarning, modelNote } = await spawnChild(client, record, options, undefined, {
      forget: (childId) => ctx.watcher.forget(childId),
      registerRemote: registrar(ctx, record),
      cleanupRemote: remoteCleanup(ctx),
      localWorkspaces: async () => parseWorkspaces(await ctx.client.workspaceList()),
    });
    // The depth-0 session's max_depth is the tree's ceiling, raised only by its own spawns.
    const tree = raiseTree(record, asked);
    if (tree !== undefined) mutateParent(record.id, (entry) => {
      entry.maxDepth = tree;
    });
    const where = child.host === LOCAL_HOST ? '' : ` on machine ${child.host}`;
    const room = child.ownsWorkspace ? `, in workspace ${workspaceName(child)}, which Bellwether created for it` : options.workspace && child.workspaceId ? `, in workspace ${workspaceName(child)}` : '';
    const lines = [`${child.name} started as a ${child.kind} agent${where} in pane ${child.paneId}, tab ${child.tabId ?? child.paneId}${room}.`, `Bellwether watches it, and your next turn starts when it changes state.`, `herdr link: ${link}`];
    if (depth.note) lines.push(depth.note);
    if (modelNote) lines.push(modelNote);
    if (reportWarning) lines.push(reportWarning);
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
    const header = 'name\tkind\tstate\tage\thost\tworkspace\tpane\tdepth\tunread\tcwd';
    const depth = record.children.flatMap((child) => describeDepth(child));
    return [header, ...record.children.map((child) => describeChild(child, ctx.watcher, ctx.relayState)), ...(depth.length ? ['', 'Depth requests and grants:', ...depth] : [])].join('\n');
  }

  if (name === 'agent_move') {
    const target = optionalString(args['child']);
    if (!target) throw new Error('agent_move needs a child');
    const known = record.children.find((entry) => entry.id === target || entry.name === target || entry.paneId === target);
    try {
      const result = await moveChild(
        {
          clientFor: (host) => clientFor(ctx, host),
          endpointFor: ctx.endpointFor ?? moveEndpoints(),
          knownHosts: ctx.knownHosts ?? (() => knownHosts()),
          registerRemote: registrar(ctx, record),
          cleanupRemote: remoteCleanup(ctx),
          log: ctx.log,
        },
        ctx.parentId,
        { child: target, machine: optionalString(args['machine']), cwd: optionalString(args['cwd']), kind: optionalString(args['kind']), reason: optionalString(args['reason']) },
      );
      const place = (host: string): string => (host === LOCAL_HOST ? 'this machine' : `machine ${host}`);
      return [
        `${result.child.name} moved from ${place(result.from)} to ${place(result.to)}, as the same child ${result.child.id}, and resumed its session in pane ${result.child.paneId}.`,
        `Its session crossed as ${result.bytes} bytes and was verified at ${result.sessionFile}. Bellwether watches it there, and collects its reports from that machine.`,
        `herdr link: ${result.link}`,
      ].join('\n');
    } finally {
      // The child's old pane and its classifier state belong to the machine it left, or to the start that failed.
      if (known) ctx.watcher.reset(known.id);
    }
  }

  const target = optionalString(args['child']);
  if (!target) throw new Error(`${name} needs a child`);
  const child = resolve(record, target);
  if (!child) throw new Error(`No child of this session matches "${target}". Call agent_list to see them.`);
  // Pane ids are scoped to one herdr server, so every call goes to the child's host.
  const herdr = await clientFor(ctx, hostOf(child));

  if (name === 'agent_read') {
    const lines = typeof args['lines'] === 'number' ? (args['lines'] as number) : undefined;
    // Pane feature: agent_read with lines, a screen the parent asked to see.
    if (lines) return (await herdr.paneRead({ paneId: child.paneId, source: 'recent_unwrapped', lines })).trim();
    if (hostOf(child) !== LOCAL_HOST) return readRemoteChild(ctx, child, herdr);
    const transcript = child.transcript ?? transcriptFromSession(ctx.parentId, child);
    const message = transcript ? lastAssistantMessage(transcript) : undefined;
    if (message) return message;
    // Pane feature: agent_read for a child whose transcript holds no message yet.
    return (await herdr.paneRead({ paneId: child.paneId, source: 'recent_unwrapped', lines: 40 })).trim();
  }

  if (name === GRANT_DEPTH_TOOL) {
    const levels = typeof args['levels'] === 'number' ? (args['levels'] as number) : Number.NaN;
    return grantDepth(ctx.parentId, caller, { child, levels, requestId: optionalString(args['request']), reason: optionalString(args['reason']) }, (target, text) => tellChild(ctx, target, text));
  }

  if (name === 'agent_send') {
    const text = optionalString(args['text']);
    const keys = Array.isArray(args['keys']) ? (args['keys'] as string[]) : undefined;
    if (keys?.length) {
      // Pane feature: agent_send keys, which the parent chose to send.
      await herdr.sendKeys(child.paneId, keys);
      return `Sent ${keys.join(' ')} to ${child.name}.`;
    }
    if (!text) throw new Error('agent_send needs text or keys');
    return promptChild(herdr, child, text);
  }

  if (name === 'agent_stop') {
    if (!args['force'] && (child.lastStatus === 'working' || child.lastStatus === 'blocked')) {
      // Pane feature: agent_stop shows the parent what the busy child is doing.
      const tail = await herdr.paneRead({ paneId: child.paneId, source: 'recent_unwrapped', lines: 20 }).catch(() => '');
      return `${child.name} is ${child.lastStatus}, so agent_stop refused to close it. Pass force to close it anyway.\n${tail.trim()}`;
    }
    if (child.tabId) await herdr.tabClose(child.tabId);
    else await herdr.paneClose(child.paneId);
    updateChild(ctx.parentId, child.id, (entry) => {
      entry.exitedAt = new Date().toISOString();
    });
    removeChildFiles(child.id);
    // A workspace Bellwether made for the child closes once nothing is left in it.
    const released = await releaseWorkspace(herdr, child).catch((error: unknown) => {
      ctx.log?.(`agent_stop: could not check ${child.name}'s workspace ${child.workspaceId}: ${(error as Error).message}`);
      return undefined;
    });
    const roomNote = released === 'kept' ? ` Its workspace ${workspaceName(child)} stays open, because it still holds another tab.` : '';
    // A child on another machine has its brief, config and relay record there.
    if (hostOf(child) !== LOCAL_HOST && ctx.remote) {
      try {
        await ctx.remote.cleanup(child);
      } catch (error) {
        ctx.log?.(`agent_stop: could not remove ${child.name}'s files on machine ${hostOf(child)}: ${(error as Error).message}`);
        return `Closed ${child.name}.${roomNote} Its brief, MCP config and relay record on machine ${hostOf(child)} could not be removed, and stay there until \`bellwether relay-cleanup --child ${child.id}\` runs on that machine: ${(error as Error).message}`;
      }
    }
    return `Closed ${child.name}.${roomNote}`;
  }

  throw new UnknownTool(name);
}

/**
 * A local child's transcript, found from its session when the record holds
 * none yet: a pi session is the file itself. What is found goes on the record.
 */
function transcriptFromSession(parentId: string, child: ChildRecord): string | undefined {
  if (!child.session) return undefined;
  const found = locateTranscript(child.harness, child.session.value, child.cwd);
  if (!found.path) return undefined;
  updateChild(parentId, child.id, (entry) => {
    entry.transcript = found.path;
    delete entry.transcriptMissing;
  });
  return found.path;
}

/**
 * Give a child the answer to its depth request through herdr's agent.prompt,
 * as agent_send does. The answer comes from the chain above it, which its own
 * parent started. A child that has gone keeps the answer on its record.
 */
async function tellChild(ctx: ToolContext, child: ChildRecord, text: string): Promise<void> {
  if (child.exitedAt || !child.paneId) return;
  try {
    await promptChild(await clientFor(ctx, hostOf(child)), child, text);
  } catch (error) {
    ctx.log?.(`depth: could not tell ${child.name} in pane ${child.paneId}: ${(error as Error).message}`);
  }
}

function registrar(ctx: ToolContext, record: { id: string }): RegisterRemote | undefined {
  const remote = ctx.remote;
  return remote ? (child, brief) => remote.register(record, child, brief) : undefined;
}

function remoteCleanup(ctx: ToolContext): ((child: ChildRecord) => Promise<void>) | undefined {
  const remote = ctx.remote;
  return remote ? (child) => remote.cleanup(child) : undefined;
}

/**
 * Read a child on another machine. Its transcript sits on that machine's disk,
 * so the read goes over the connection the daemon holds to that machine for
 * its reports, and works after the child exits, while the transcript is still
 * there. When the hop fails, the
 * last report the child sent is what this machine holds, and then the screen,
 * which only a live child has.
 */
async function readRemoteChild(ctx: ToolContext, child: ChildRecord, herdr: HerdrClient): Promise<string> {
  let hopError: string | undefined;
  try {
    const message = await ctx.remote?.lastMessage(child);
    if (message?.trim()) return message;
  } catch (error) {
    hopError = (error as Error).message;
  }
  const why = hopError ? `Its transcript on machine ${child.host} could not be read (${hopError}).` : `Machine ${child.host} has no transcript message for it.`;
  if (child.lastReport) return `${why} Its last report, ${child.lastReport.status} at ${child.lastReport.at}:\n${child.lastReport.text}`;
  if (!child.exitedAt) {
    // Pane feature: agent_read on a remote child with no transcript and no report.
    const screen = await herdr.paneRead({ paneId: child.paneId, source: 'recent_unwrapped', lines: 40 }).catch(() => '');
    if (screen.trim()) return screen.trim();
  }
  return `${why} It never reported${child.exitedAt ? ', and it has exited, so there is no screen to read' : ''}.`;
}

export function hostEnv(): Record<string, string> {
  return { host: os.hostname() };
}
