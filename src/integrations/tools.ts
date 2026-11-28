// The Bellwether tools, in one list, so the Pi extension and the Claude
// MCP channel server register exactly the same names and schemas.
import { childPaneEnd, herdrView, type HerdrView } from '../core/pane-fate.ts';
import os from 'node:os';
import type { HerdrClient } from '../core/herdr-client.ts';
import { BLANK_SCREEN, shownScreen } from '../core/screen.ts';
import { spawnChild, type RegisterRemote, type SpawnOptions } from '../core/spawn.ts';
import { agentKinds, harnessFor, harnessNamed, locateTranscript } from '../core/harnesses/index.ts';
import { GRANT_DEPTH_TOOL, REQUEST_DEPTH_TOOL, ceilingOf, childCeiling, describeDepth, grantDepth, raiseTree, requestDepth } from '../core/depth.ts';
import { keepsBriefs, type NextBrief } from '../core/brief-history.ts';
import { removeChildFiles } from '../core/mcp-config.ts';
import { PROMPT_NOTICE, localParentOf, notePromptForCaller, reportForCaller, reportViaLine } from '../core/report.ts';
import { childById, describeDecisions, mutateParent, readParent, updateChild } from '../core/registry.ts';
import { checkReads } from '../core/reads.ts';
import { adoptPane } from '../core/adopt.ts';
import { LOCAL_HOST, hostOf, knownHosts, type ClientFor } from '../core/machine.ts';
import { spawnResume } from '../core/spawn-resume.ts';
import { describeBrief } from '../core/brief-delivery.ts';
import { describeMessages, messageChild, type Inbox } from '../core/send.ts';
import { RESTART_TOOL, runAgentRestart, type RestartHooks } from '../core/restart.ts';
import { RETIRE_TOOL, farWorktreesLine, goneCwdLine, realRetireOps, requestRetirement, retireLine, retireOnStop, type RetireOps } from '../core/retire.ts';
import type { RemoteOps } from '../core/remote.ts';
import { lastAssistantMessage } from '../core/transcript.ts';
import { moveChild } from '../core/move.ts';
import { isMoving } from '../core/move-plan.ts';
import { crossingState } from '../core/recover-crossing.ts';
import { compareVersions } from '../core/move-plan.ts';
import { requestSelfTeleport, teleportChild, teleportReply } from '../core/teleport.ts';
import { predates } from '../daemon/relay-links.ts';
import { routeLabel } from '../core/routes.ts';
import { parseWorkspaces, releaseWorkspace, workspaceColumn, workspaceName } from '../core/workspace.ts';
import { moveEndpoints, type EndpointFor } from '../core/move-endpoint.ts';
import type { Watcher } from '../core/watcher.ts';
import type { CallerIdentity, ChildRecord, RelayHostState, ReportStatus } from '../core/types.ts';
import type { SessionReach } from '../core/adopted-session.ts';
import { FEATURES, featureNamed, serves, type DaemonOffer, type Feature } from '../daemon/features.ts';
import { runEnds } from '../core/incarnation.ts';

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
  /** The daemon's way into a child's own session, for a parent's message. Without it, a message is typed into the pane. */
  inbox?: Inbox;
  /** Whether a Bellwether adapter from a pane on this machine is connected to the daemon, so an adoption can say whether the session can report. */
  sessionReach?: (paneId: string) => SessionReach;
  /** Whether the adapter connected from an adopted pane on this machine takes a parent's message, or undefined when none is. */
  sessionMessages?: (paneId: string) => boolean | undefined;
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
    description: 'Start a child coding agent in its own herdr tab, of any kind herdr can start. Bellwether watches it and starts your next turn when it reports, goes idle, blocks, stalls or exits. Give the prompt a concrete deliverable, and tell the child to call parent_report when it is done. With resume, the call is a message to an earlier child instead: a child herdr still shows gets the prompt as an ordinary message, with no new tab, and a retired one comes back in a new tab with its harness reopening the same session, under the same child id, so its history and unread events continue. Resume works for a child whose harness Bellwether can reopen, which docs/harnesses.md lists.',
    schema: {
      type: 'object',
      properties: {
        resume: { type: 'string', description: 'Message an earlier child rather than start a new one: its name, its id, or its session id. herdr decides whether it is alive. A session id no child of this session ran also takes kind, name, cwd and machine, and comes back as a new child. Omit it to start a new child.' },
        // Read from the harness registry each time the list is sent, so a harness's entry is all it takes to offer its kind.
        kind: {
          type: 'string',
          get enum(): string[] {
            return agentKinds();
          },
          get description(): string {
            return `The harness to start: ${agentKinds().join(', ')}. Required without resume.`;
          },
        },
        name: { type: 'string', description: 'A short handle for the child, unique in this session. Used as the herdr agent name and the tab label. Required without resume.' },
        cwd: { type: 'string', description: 'The directory to start the child in. Use an absolute path, ideally a git worktree of its own. Required for an opencode child, whose brief goes inside it.' },
        prompt: { type: 'string', description: 'The first message the child receives, or with resume the message for the earlier child. The whole prompt, not a path. Line breaks and any length are fine. Bellwether keeps it in a private file, and a claude, pi or omp child gets it as a message in its session once its harness runs, typed into its pane when that session does not take it; the reply says which path carried it, and a harness that exits before taking it fails the spawn.' },
        model: { type: 'string', description: 'The model to pass to the child harness, or with via a tier of that route. A pi child needs provider with it; with neither, a pi child runs on the provider and model of this session. A tier passed without via is refused, and the refusal names the route that has it. A bare opencode child takes provider/model, which goes in its configuration as the default model.' },
        via: { type: 'string', description: 'Start the child through a route: a launcher wrapper that this machine\'s routes file (~/.config/bellwether/routes.json, or BELLWETHER_ROUTES) defines, which runs the harness and routes it. model then names one of the route\'s tiers, and the route\'s default tier applies without one. Pass none for a bare start. With resume, a route moves the child onto it and none takes it off, on the same session; omit it to keep the route the child ran on.' },
        key_file: { type: 'string', description: 'A file that holds the key the route\'s launcher runs under, such as another tenant\'s. Needs via. The file must exist and not be empty. Its path goes on the child\'s record, and the pane\'s shell reads the file when the launch runs, so the key never appears on a command line.' },
        provider: { type: 'string', description: 'The pi provider for model. Pass both or neither.' },
        args: { type: 'array', items: { type: 'string' }, description: 'Extra arguments for the child harness, passed through unchanged and appended last.' },
        focus: { type: 'boolean', description: 'Move your view to the new tab. Defaults to false, so the child does not steal focus.' },
        reads: { type: 'array', items: { type: 'string' }, description: 'Absolute paths the child reads beside its working directory and the Bellwether home, which holds its brief: a directory with everything under it, or one file. Name what the brief needs, such as another checkout\'s lint config; the root and the operator\'s home are refused. A claude child\'s launch settings list them, so Claude Code never asks about a read there, and a resume or restart keeps them. The list is not a limit: whether a read elsewhere is asked about is the machine\'s decision. Where Claude Code asks, Bellwether answers No and tells you which path it declined. Where the machine already allows such reads, as Claude Code does in auto mode once it has asked on that machine, the child reads outside the list without a question and you hear nothing of it. Refused for a harness whose launch takes no read set.' },
        stuck_minutes: { type: 'number', description: 'How long the child may be quiet before it counts as stuck. Defaults to 10.' },
        inactive_minutes: { type: 'number', description: 'How long the child may show no activity of any kind, blocked included, before you are told. Defaults to 5. Clamped to between 1 and 1440. It cannot be turned off.' },
        max_depth: { type: 'number', description: 'The deepest generation the child\'s own descendants may reach: with 2, your child may spawn children but they may not. Defaults to 2. From the session at the top of the tree, it also sets the tree\'s ceiling, which no grant goes past, and it gates this call: the child itself, one level down, must fit under it, so max_depth 0 refuses the spawn. From any other session, it is held to your own ceiling. A child in a workspace of its own counts the same depth as any other.' },
        machine: { type: 'string', description: `${MACHINE_DESCRIPTION} With resume, a known child always goes back to its own machine.` },
        workspace: { type: 'string', description: 'The herdr workspace for the child\'s tab. "new" creates a workspace for the child, on the child\'s machine, and starts the child in its first tab; the child\'s own children then open there too, so its subtree stays out of your workspace, and Bellwether closes that workspace once nothing is left in it. An existing workspace\'s id or label puts the child there, on the child\'s machine, and Bellwether never closes it; a name that matches nothing is refused. Omit it to open the child in your own workspace, as before.' },
        workspace_label: { type: 'string', description: 'The label of the workspace that workspace "new" creates. Defaults to the child\'s name.' },
      },
    },
  },
  {
    name: 'agent_adopt',
    description: "Make a running agent that this session did not start into its child, such as one herdr-spawn.sh or a person started, on this machine or on a saved herdr machine. Bellwether then watches it like a spawned child, and its status changes start your turns. Refuses an unknown machine, a pane with no agent herdr recognizes, a pane another session already watches (on another machine, that machine's daemon answers who), and a machine whose Bellwether predates remote adoption. While the connection to that machine is down, agent_list shows the child unreachable, not exited, and it comes back when the connection does, with no second adoption. Whether the adopted child can answer depends on what its session loaded when it started. A session that holds a Bellwether server or extension, such as pi with Bellwether's package or Claude Code with Bellwether's plugin or a user-level server, gains parent_report over the connection it already holds, and its reports reach you, on this machine or another; that machine needs Bellwether 0.1.7 or later. A session that loaded none cannot call parent_report, and nothing Bellwether can do while it runs changes that: you get its status changes, and agent_send types into its pane. The reply says which of the two you adopted. Bellwether never answers a dialog in an adopted child's pane, because its session started under settings Bellwether did not choose and its pane is not this session's to type into: when it stops at a question, even one Bellwether answers for a child it spawned, you get a blocked event that names the question, and the answer is yours, through agent_send keys.",
    schema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'The pane id, as w1:p5 or w7R:p1, or the herdr name of the live agent. Write machine:pane, as child-box:w7R:p1, for a pane on a saved herdr machine.' },
        name: { type: 'string', description: 'The handle to use for the child. Defaults to its herdr name.' },
        machine: { type: 'string', description: 'A saved herdr machine, by label or id as `herdr machine list` shows it. Omit it for this machine. Bellwether reads the pane from that machine\'s herdr, and asks the Bellwether daemon there, over the SSH connection this machine\'s daemon holds, to record the adoption, so that machine needs Bellwether 0.1.6 or later. That machine never connects back.' },
        stuck_minutes: { type: 'number', description: 'How long the child may be quiet before it counts as stuck. Defaults to 10.' },
      },
      required: ['target'],
    },
  },
  {
    name: 'agent_list',
    description: 'List this session\'s children with status, age and unread events, then each child\'s depth requests, how its newest brief arrived, and its newest messages from you, with the path each took and whether its model has read it. The record keeps a brief\'s delivery on the brief, at children[].briefs[].delivery, because each resume that brings a prompt adds a brief of its own.',
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
    description: "Send a child a message. A claude, pi or omp child on this machine gets it in its session, through its own Bellwether channel or extension, as a message rather than typing: an idle child starts a turn on it, and a busy one takes it after the tool calls in flight, before its next model call, the same moment typed input would reach it. Any other child, a child on another machine, and a child whose Bellwether session does not take the message within 5 s get it typed into their pane through herdr's agent.prompt instead. The reply says which path carried it and why, and agent_list shows each message's path and whether the child's model has read it; a child that exits before reading a session message gets an exit event that names the message. herdr refuses a blocked child, so for one this returns the dialog and takes keys to answer it instead.",
    schema: {
      type: 'object',
      properties: {
        child: { type: 'string', description: 'The child\'s name, its pane id, or the id agent_spawn returned.' },
        text: { type: 'string', description: 'The message to send.' },
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
    description: 'Move a live claude or pi child to another machine, in either direction, keeping its child id, its name and its conversation: Bellwether copies the harness session to the other machine, checks the copy, closes the child\'s tab, and resumes the session there, and the parent dials the new machine for its reports from then on. If the child cannot start on the other machine, Bellwether starts it again where it was and says the move failed. It refuses, before touching anything: a different harness on the other machine (a session belongs to the harness that wrote it); a harness missing there, or older than the version that wrote the session, which could lose the conversation; a pi child whose provider and model pair the other machine does not offer; a working directory that does not exist there; a child that is working or blocked, because the move would cut its turn short; a child that has exited or has no recorded session; a child another resume or move holds; and, unless you pass accept_loss, a child that would leave work behind: a background job its session runs, which ends when its tab closes, or a worktree its session worked in that holds uncommitted changes, a stash or unpushed commits. A session crosses, and its processes and worktrees stay where they are. It also stops, and removes the copy, when the copy does not read back with the same bytes and checksum. The working directory is not copied: the repository has to be on the other machine already.',
    schema: {
      type: 'object',
      properties: {
        child: { type: 'string', description: 'The child\'s name, its pane id, or the id agent_spawn returned.' },
        machine: { type: 'string', description: 'The machine to move to: a saved herdr machine by label or id, or local for this one. Omit it when exactly one other machine is known; with more, the call is refused as ambiguous.' },
        cwd: { type: 'string', description: 'The directory the child resumes in on the other machine. Defaults to the directory it runs in now, which must exist there.' },
        kind: { type: 'string', enum: ['claude', 'pi'], description: 'The harness to run on the other machine. Defaults to the child\'s own, and any other is refused.' },
        reason: { type: 'string', description: 'Why the child moves, kept in move.log.' },
        accept_loss: { type: 'boolean', description: 'Move even though the refusal named work that would stay behind: background jobs, which end with the session, or worktree changes and commits that exist only on this machine. The reply names each one again.' },
      },
      required: ['child'],
    },
  },
  {
    name: 'agent_teleport',
    description: 'Teleport a claude or pi child to another machine, live or stopped, keeping its child id, its name and its conversation. Bellwether does three things: it starts the child at the destination, in a directory that already exists there, resuming its session (copied and checked byte for byte, as agent_move does); it proves the child is alive; and it tells the child it was teleported, as the first message its session reads, naming both machines, both directories, who asked and why. The notice goes into the session and is never typed into a pane. You prepare the destination first: the folder, the worktree and any program the child needs. Bellwether never copies a worktree or creates a directory. A stopped child starts at the destination at once, which agent_move refuses. When the session takes the notice late or not at all, the child keeps running at the destination and the reply says it was not told. It refuses, before touching anything: a destination directory that does not exist; a destination harness older than the version that wrote the session; a destination with no inbound path for the notice, such as a machine whose Bellwether predates relay-message; an adopted child; a working or blocked child; and, unless you pass accept_loss, a child that would leave a background job or unpushed worktree work behind. Every other refusal of agent_move applies too. A child Bellwether started can teleport itself: leave out child, and the daemon replies first, waits for this turn to end within 5 minutes, then teleports it as its parent, and the notice says it asked. Parent sessions cannot teleport.',
    schema: {
      type: 'object',
      properties: {
        child: { type: 'string', description: 'The child\'s name, its pane id, or the id agent_spawn returned. Omit it to teleport this session itself, when Bellwether started it as a child: the teleport then runs once this turn ends.' },
        machine: { type: 'string', description: 'The destination: a saved herdr machine by label or id, or local for this one. Omit it when exactly one other machine is known.' },
        cwd: { type: 'string', description: 'The directory the child resumes in at the destination, which must already exist there. Defaults to the directory it runs in now.' },
        kind: { type: 'string', enum: ['claude', 'pi'], description: 'The harness to run at the destination. Defaults to the child\'s own, and any other is refused.' },
        reason: { type: 'string', description: 'Why the child crosses. The child reads it in its notice, and the record and teleport.log keep it.' },
        accept_loss: { type: 'boolean', description: 'Teleport even though the refusal named work that would stay behind: background jobs, which end with the session, or worktree changes and commits that exist only on the source. The reply names each one again.' },
      },
      required: [],
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
        via: { type: 'string', description: 'For a child: restart it through this route from the routes file, or none to restart it bare, on the same session either way. Omit it to keep the route it runs on.' },
        model: { type: 'string', description: 'For a child: the tier on a route, or the harness model on a bare start.' },
        key_file: { type: 'string', description: 'For a child on a route: a file that holds the key the launcher runs under. Without it, a child that stays on its route keeps its key file.' },
        provider: { type: 'string', description: 'For a pi child restarted bare: the provider for model. A pi child leaving a route needs both, because its session names the route\'s provider.' },
        reads: { type: 'array', items: { type: 'string' }, description: 'For a child: the absolute paths it reads beside its working directory and the Bellwether home, replacing the list it had; [] clears it. Use it when an event says Bellwether declined a read the brief needs: the child restarts on the same session with that path in its launch settings. Omit it to keep the list.' },
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
    description: 'Ask to be retired once you exit: the Bellwether daemon then removes your worktree and deletes your branch, but only after your pane and tab are gone, the worktree is not a main worktree, is clean and has no stash, the work is merged into the default branch, on a remote branch, or in a merged pull request whose head is your tip, and no process works inside it. The call removes nothing. It runs the checks it can run now and says which pass, records the request, and leaves the rest to the daemon. Never remove your own worktree: your harness runs every command from it until your tab closes. Close your tab afterwards.',
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

/** Who a session is, as its hello tells the daemon: the parent its environment names, and the child id its spawn gave it. */
export interface ToolScope {
  reportsTo?: string;
  childId?: string;
}

/**
 * The tools a daemon serves a session: the list for the session's identity,
 * each one a tool in the feature table. The daemon sends this list in its
 * hello, and the adapter offers it unchanged, so the daemon alone decides
 * which tools a session has, and a newer daemon brings its tools to every
 * session connected to it.
 */
export function servedTools(scope: ToolScope, features: readonly Feature[] = FEATURES): ToolDefinition[] {
  const named = new Set(features.filter((feature) => feature.kind === 'tool').map((feature) => feature.name));
  return toolsFor({ parent: scope.reportsTo, child: scope.childId }).filter((tool) => named.has(tool.name));
}

/**
 * The tools an adapter offers when its daemon predates the served list: its
 * own list for the session, less each tool the daemon does not serve, so the
 * model is never offered a tool whose call the daemon would refuse.
 */
export function fallbackTools(scope: ToolScope, offer: DaemonOffer | undefined): ToolDefinition[] {
  const own = toolsFor({ parent: scope.reportsTo, child: scope.childId });
  if (!offer) return own;
  return own.filter((tool) => {
    const feature = featureNamed(tool.name);
    return !feature || serves(offer, feature);
  });
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

/**
 * The end of the adoption's sentence about a session that now reports: what a
 * message from agent_send does in it (issue #168). Unknown, as from a far
 * daemon that predates the answer, promises nothing.
 */
function adoptedMessages(messages: boolean | undefined, kind: string): string {
  if (messages === true) return ', and a message from agent_send enters its session.';
  if (messages === undefined) return '.';
  const inbox = harnessFor(kind)?.inbox;
  return `. ${inbox && inbox.via !== 'none' ? inbox.adopted.reply : 'Its Bellwether adapter takes no messages, so agent_send types into its pane.'}`;
}

/**
 * What an adoption gives the parent, in one paragraph: whether the adopted
 * session can report, from the daemon where its pane runs, which knows which
 * Bellwether adapters are connected there.
 */
export function adoptedReach(reach: SessionReach | undefined, host: string, messages?: boolean, kind = ''): string {
  const daemon = host === LOCAL_HOST ? "this machine's daemon" : `the daemon on machine ${host}`;
  if (reach === 'tools') return `Its session holds a Bellwether server or extension, connected to ${daemon}, which now offers it parent_report: a report from it reaches this session${adoptedMessages(messages, kind)}`;
  if (reach === 'older') return `Its session holds a Bellwether server or extension, connected to ${daemon}, from a release before 0.1.7, which takes no new tool list while it runs. It gains parent_report the next time it connects to the daemon, as after an upgrade hands the daemon over. Until then, its status changes start your turns.`;
  if (reach === 'none') return `Its session holds no Bellwether server or extension connected to ${daemon}, so it cannot call parent_report. Its status changes still start your turns, and agent_send types into its pane. A session gets parent_report only from a Bellwether server or extension it loaded at its start: a plugin, a user-level server or pi's package.`;
  if (host !== LOCAL_HOST) return `Bellwether on machine ${host} predates 0.1.7, so it routes no report from an adopted session there: this child cannot call parent_report until that machine runs 0.1.7 or later. Its status changes still start your turns.`;
  return 'This daemon cannot see which Bellwether adapters are connected, so whether this child can call parent_report is unknown. Its status changes still start your turns.';
}

/** A herdr workspace id: `w` and letters or digits, as w1, w32 or w7R once herdr has made more than a hundred workspaces (issue #233). */
const WORKSPACE_ID = /^w[0-9A-Za-z]+$/;
/** The pane half of a herdr pane id, as p1 or pB. */
const PANE_PART = /^p[0-9A-Za-z]+$/;

/** The machine and pane an adoption names, and the other way to read it, when there is one. */
export interface AdoptTarget {
  host: string;
  target: string;
  /** For a pane id on this machine, as w7R:p1: the agent its second half names on a saved machine its first half names. */
  otherReading?: { host: string; target: string };
}

/**
 * The machine and pane an adoption names. A pane id is a workspace id and a
 * pane, as w1:p5 or w7R:p1, and reads as a pane on this machine, or on the
 * machine the call names. A target with two colons names its machine first,
 * as child-box:w7R:p1, and so does one whose halves are not a pane id, as
 * child-box:first-mate. The shape decides, never a lookup: w7R:p1 is a pane
 * id, and `otherReading` keeps the agent p1 on a machine labelled w7R, which
 * the caller names only when this machine has no such pane and that machine
 * is saved.
 */
export function adoptTarget(target: string, machine?: string): AdoptTarget {
  const colon = target.indexOf(':');
  const prefix = colon > 0 ? target.slice(0, colon) : '';
  const rest = colon > 0 ? target.slice(colon + 1) : '';
  const paneId = Boolean(prefix && rest) && WORKSPACE_ID.test(prefix) && PANE_PART.test(rest);
  const prefixed = Boolean(prefix && rest) && !paneId;
  if (!prefixed) return { host: machine ?? LOCAL_HOST, target, ...(paneId && !machine ? { otherReading: { host: prefix, target: rest } } : {}) };
  if (machine && machine !== prefix) throw new Error(`agent_adopt names machine ${machine}, but its target ${target} names machine ${prefix}. Name one.`);
  return { host: prefix, target: rest };
}

/**
 * The refusal for a pane id that this machine lacks while a saved machine
 * carries its first half as a label: the target reads two ways, and the
 * caller names which (issue #233).
 */
async function ambiguousTarget(ctx: ToolContext, given: string, parsed: AdoptTarget, error: Error): Promise<Error> {
  const other = parsed.otherReading;
  if (!other) return error;
  const hosts = await (ctx.knownHosts ?? (() => knownHosts()))().catch(() => [] as string[]);
  if (!hosts.includes(other.host)) return error;
  return new Error(`${given} reads two ways: pane ${given} on this machine, which herdr does not show (${error.message.replace(/\.$/, '')}), or the agent ${other.target} on the saved machine ${other.host}. Name the machine to adopt there, with machine: "${other.host}" and target: "${other.target}", or ${other.host}:${other.target} with a pane id, as ${other.host}:w1:p1.`);
}

/** How long agent_stop waits for the retirement it starts before it answers without the outcome. */
const STOP_RETIRE_WAIT_MS = 10_000;

/** A child's host, with a warning when the daemon is not hearing from that machine. */
function hostColumn(child: ChildRecord, relayState: ToolContext['relayState']): string {
  const host = hostOf(child);
  if (host === LOCAL_HOST || !relayState) return host;
  const state = relayState(host);
  if (!state) return child.exitedAt ? host : `${host} (no connection)`;
  if (state.status === 'connected') return host;
  return `${host} (not heard from: ${state.status}${state.lastError ? `, ${state.lastError}` : ''})`;
}

function describeChild(child: ChildRecord, watcher: Watcher, relayState?: ToolContext['relayState'], view?: HerdrView): string {
  const unread = watcher.outboxEntries().filter((entry) => !entry.read && entry.childId === child.id).length;
  const age = Math.max(0, Math.round((Date.now() - Date.parse(child.startedAt)) / 1000));
  const restart = child.restartRequestedAt ? ', restart pending' : '';
  const retire = child.retireOutcome === 'removed' ? ', retired' : child.retireOutcome === 'partial' ? ', retired in part' : child.retireOutcome === 'refused' ? ', retirement refused' : child.retireRequestedAt ? ', retirement requested' : '';
  const away = child.exitedAt ? undefined : watcher.unreachable(hostOf(child));
  const live = away ? `unreachable since ${away.since} (last seen ${child.lastStatus})` : child.lastStatus;
  // A child that is crossing to another machine is unreachable, not exited (issue #219 was the same confusion for a far claim).
  const crossing = isMoving(child) ? crossingState(child) : undefined;
  const state = `${crossing ?? (child.exitedAt ? `exited${child.exitCode === undefined ? '' : ` (${child.exitCode})`}` : live)}${child.crossingFailed ? ', on neither machine since a crossing failed' : ''}${restart}${retire}`;
  // An exited child names what became of its last pane, in a column of its own at the end (issue #187).
  const ended = childPaneEnd(child, hostOf(child) === LOCAL_HOST ? view : undefined) ?? '-';
  const name = child.agentName ? `${child.name} (${child.agentName})` : child.name;
  const kind = child.model ? `${child.kind} (${child.model.provider}/${child.model.id})` : child.kind;
  return `${name}\t${kind}\t${routeLabel(child.route)}\t${state}\t${age}s\t${hostColumn(child, relayState)}\t${workspaceColumn(child)}\t${child.paneId}\t${child.depth}/${ceilingOf(child)}\tunread ${unread}\t${child.cwd ?? ''}\t${ended}`;
}

/** The last report of each child, with the path that sent it. */
function describeLastReports(children: readonly ChildRecord[]): string[] {
  return children.flatMap((child) => {
    const report = child.lastReport;
    if (!report) return [];
    return [`${child.name}: ${report.status} at ${report.at}, ${reportViaLine(report.via, report.toolOffered)}.`];
  });
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
    // The source names the harness whose adapter sent it; pi's extension, the first, sends none.
    const source = harnessNamed(optionalString(args['source']))?.harness ?? 'pi';
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
    const change = { via: optionalString(args['via']), model: optionalString(args['model']), keyFile: optionalString(args['key_file']), provider: optionalString(args['provider']), reads: checkReads(args['reads']) };
    const remote = ctx.remote;
    const relay = remote?.restart ? (host: string, ask: Parameters<NonNullable<typeof remote.restart>>[1]) => (remote.restart as NonNullable<typeof remote.restart>)(host, ask) : undefined;
    return runAgentRestart(ctx.client, ctx.parentId, caller, { ...(ctx.restart ?? {}), reset: (childId) => ctx.watcher.reset(childId), ...(relay ? { relay } : {}) }, optionalString(args['target']), typeof args['wait_seconds'] === 'number' ? (args['wait_seconds'] as number) : undefined, change);
  }

  if (name === 'agent_teleport' && !optionalString(args['child'])) {
    // A child teleports itself: routed by the caller's identity, as a self-restart is (issue #226).
    const remote = ctx.remote;
    return requestSelfTeleport(
      {
        clientFor: (host) => clientFor(ctx, host),
        endpointFor: ctx.endpointFor ?? moveEndpoints(),
        knownHosts: ctx.knownHosts ?? (() => knownHosts()),
        ...(remote ? { registerFor: (parentId: string) => (child, brief) => remote.register({ id: parentId }, child, brief), cleanupRemote: (child) => remote.cleanup(child) } : {}),
        log: ctx.log,
        ...(ctx.inbox ? { inbox: ctx.inbox } : {}),
        inbound: async (host) => farInboundGap(host, ctx.relayState?.(host)),
        from: 'Bellwether, at your own request',
      },
      caller,
      { machine: optionalString(args['machine']), cwd: optionalString(args['cwd']), reason: optionalString(args['reason']), kind: optionalString(args['kind']) },
      { ...(ctx.restart ?? {}) },
    );
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
      via: optionalString(args['via']),
      keyFile: optionalString(args['key_file']),
      provider: optionalString(args['provider']),
      args: Array.isArray(args['args']) ? (args['args'] as string[]) : undefined,
      focus: args['focus'] === true,
      registerRemote: registrar(ctx, record),
      cleanupRemote: remoteCleanup(ctx),
      inbox: ctx.inbox,
      from: senderName(record),
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
    lines.push(`${child.name} resumed session ${result.session.value}${where} in pane ${child.paneId}, as the same child ${child.id}, on route ${routeLabel(child.route)}.`, 'Bellwether watches it again, and its earlier events and receipts carry on.');
    const repeated = repeatedBriefNote(child, result.brief);
    if (repeated) lines.push(repeated);
    if (result.briefNote) lines.push(result.briefNote);
    lines.push(`herdr link: ${result.link}`);
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
      via: optionalString(args['via']),
      keyFile: optionalString(args['key_file']),
      provider: optionalString(args['provider']),
      parentModel: caller.model,
      args: Array.isArray(args['args']) ? (args['args'] as string[]) : undefined,
      focus: args['focus'] === true,
      stuckMinutes: typeof args['stuck_minutes'] === 'number' ? (args['stuck_minutes'] as number) : undefined,
      reads: checkReads(args['reads']),
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
    const { child, link, modelNote, harnessNote, envNote, startNote, briefNote, integrationNote, decisions } = await spawnChild(client, record, options, undefined, {
      forget: (childId) => ctx.watcher.forget(childId),
      registerRemote: registrar(ctx, record),
      cleanupRemote: remoteCleanup(ctx),
      localWorkspaces: async () => parseWorkspaces(await ctx.client.workspaceList()),
      inbox: ctx.inbox,
      from: senderName(record),
    });
    // The depth-0 session's max_depth is the tree's ceiling, raised only by its own spawns.
    const tree = raiseTree(record, asked);
    if (tree !== undefined) mutateParent(record.id, (parentRecord) => {
      parentRecord.maxDepth = tree;
    });
    const where = child.host === LOCAL_HOST ? '' : ` on machine ${child.host}`;
    const room = child.ownsWorkspace ? `, in workspace ${workspaceName(child)}, which Bellwether created for it` : options.workspace && child.workspaceId ? `, in workspace ${workspaceName(child)}` : '';
    const lines = [`${child.name} started as a ${child.kind} agent${where} in pane ${child.paneId}, tab ${child.tabId ?? child.paneId}${room}${child.route ? `, on route ${routeLabel(child.route)}` : ''}.`, `Bellwether watches it, and your next turn starts when it changes state.`, `herdr link: ${link}`];
    if (briefNote) lines.push(briefNote);
    if (depth.note) lines.push(depth.note);
    if (modelNote) lines.push(modelNote);
    if (harnessNote) lines.push(harnessNote);
    if (startNote) lines.push(startNote);
    if (envNote) lines.push(envNote);
    if (integrationNote) lines.push(integrationNote);
    if (decisions?.length) lines.push(describeDecisions(child.name, decisions));
    return lines.join('\n');
  }

  if (name === 'agent_adopt') {
    const given = optionalString(args['target']);
    if (!given) throw new Error('agent_adopt needs a target: a pane id or a live agent name');
    const parsed = adoptTarget(given, optionalString(args['machine']));
    const { host, target } = parsed;
    let client: HerdrClient;
    try {
      client = await clientFor(ctx, host);
    } catch (error) {
      throw new Error(`Cannot adopt ${target} on machine ${host}: ${(error as Error).message}`);
    }
    const claim = ctx.remote?.claim?.bind(ctx.remote);
    const { child, link, already, revived, from, replaced, restored, unconfirmed, inDoubt, session: farReach, messages: farMessages } = await adoptPane(client, record, { target, host, name: optionalString(args['name']), stuckMinutes: typeof args['stuck_minutes'] === 'number' ? (args['stuck_minutes'] as number) : undefined, ...(claim ? { claim } : {}) }).catch(async (error: unknown) => {
      throw await ambiguousTarget(ctx, given, parsed, error as Error);
    });
    if (already) {
      const held = `${child.name} in pane ${child.paneId} is already a child of this session.`;
      // Issue #219: the claim on the child's machine was asked for again.
      if (restored) return [`${held} Machine ${host} had lost its record of it, and holds it again as child ${child.id}.`, adoptedReach(farReach, host, farMessages, child.kind), `herdr link: ${link}`].join('\n');
      if (unconfirmed) return `${held} Machine ${host} could not confirm it: ${unconfirmed}.`;
      return held;
    }
    // Issue #211: the relay lost the far machine's answer, so the claim there is unknown until the watcher asks again.
    if (inDoubt) return [`Machine ${host} did not answer the adoption of pane ${child.paneId} (${inDoubt}), so Bellwether does not know whether it recorded it. The child stands as ${child.name}, child ${child.id}, in doubt: Bellwether asks that machine again and reports what it learns. Until then the child sends no events.`, `herdr link: ${link}`].join('\n');
    const where = host === LOCAL_HOST ? '' : ` on machine ${host}`;
    const session = child.session ? ` Its harness session is ${child.session.value}.` : '';
    const outage = host === LOCAL_HOST ? '' : ` While the connection to machine ${host} is down, agent_list shows it unreachable, not exited.`;
    const reach = host === LOCAL_HOST ? ctx.sessionReach?.(child.paneId) : farReach;
    const messages = host === LOCAL_HOST ? ctx.sessionMessages?.(child.paneId) : farMessages;
    // Issue #191: a harness that resumed the session of a child adopted before is that child, under its id.
    const first = revived
      ? `Adopted ${child.name} again, as the same child ${child.id}: its harness resumed session ${child.session?.value ?? 'unknown'} in pane ${child.paneId}${from ? `, where pane ${from} ran it before` : ''}. Bellwether watches it from now on.${outage}`
      : `Adopted ${child.name}, a ${child.kind} agent${where} in pane ${child.paneId}, as child ${child.id}. Bellwether watches it from now on.${session}${outage}${replaced ? ` Machine ${host} holds session ${child.session?.value ?? 'unknown'} in pane ${child.paneId} as child ${child.id}, so that child id replaces ${replaced}, which stays exited.` : ''}`;
    return [first, adoptedReach(reach, host, messages, child.kind), `herdr link: ${link}`].join('\n');
  }

  if (name === 'agent_list') {
    if (!record.children.length) return 'No children yet. Start one with agent_spawn.';
    const header = 'name\tkind\troute\tstate\tage\thost\tworkspace\tpane\tdepth\tunread\tcwd\tlast pane';
    const depth = record.children.flatMap((child) => describeDepth(child));
    const briefs = record.children.flatMap((child) => describeBrief(child));
    const messages = record.children.flatMap((child) => describeMessages(child));
    // One look at herdr says whether an exited child's workspace went with its pane.
    const view = record.children.some((child) => child.exitedAt && hostOf(child) === LOCAL_HOST) ? await herdrView(ctx.client) : undefined;
    const reports = describeLastReports(record.children);
    return [header, ...record.children.map((child) => describeChild(child, ctx.watcher, ctx.relayState, view)), ...(depth.length ? ['', 'Depth requests and grants:', ...depth] : []), ...(briefs.length ? ['', `Each child's newest brief and how it arrived (on the record, children[].briefs[].delivery):`, ...briefs] : []), ...(messages.length ? ['', 'Messages to children, newest three each:', ...messages] : []), ...(reports.length ? ['', 'Last reports:', ...reports] : [])].join('\n');
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
        { child: target, machine: optionalString(args['machine']), cwd: optionalString(args['cwd']), kind: optionalString(args['kind']), reason: optionalString(args['reason']), acceptLoss: args['accept_loss'] === true },
      );
      const place = (host: string): string => (host === LOCAL_HOST ? 'this machine' : `machine ${host}`);
      return [
        `${result.child.name} moved from ${place(result.from)} to ${place(result.to)}, as the same child ${result.child.id}, and resumed its session in pane ${result.child.paneId}.`,
        `Its session crossed as ${result.bytes} bytes and was verified at ${result.sessionFile}. Bellwether watches it there, and collects its reports from that machine.`,
        ...(result.leftBehind.length ? [`Left behind, as accept_loss allowed:`, ...result.leftBehind.map((line) => `- ${line}`)] : []),
        `herdr link: ${result.link}`,
      ].join('\n');
    } finally {
      // The child's old pane and its classifier state belong to the machine it left, or to the start that failed.
      if (known) ctx.watcher.reset(known.id);
    }
  }

  if (name === 'agent_teleport') {
    const target = optionalString(args['child']);
    if (!target) throw new Error('agent_teleport needs a child');
    const known = record.children.find((entry) => entry.id === target || entry.name === target || entry.paneId === target);
    try {
      const result = await teleportChild(
        {
          clientFor: (host) => clientFor(ctx, host),
          endpointFor: ctx.endpointFor ?? moveEndpoints(),
          knownHosts: ctx.knownHosts ?? (() => knownHosts()),
          registerRemote: registrar(ctx, record),
          cleanupRemote: remoteCleanup(ctx),
          log: ctx.log,
          ...(ctx.inbox ? { inbox: ctx.inbox } : {}),
          inbound: async (host) => farInboundGap(host, ctx.relayState?.(host)),
          by: record.id,
          from: senderName(record),
        },
        ctx.parentId,
        { child: target, machine: optionalString(args['machine']), cwd: optionalString(args['cwd']), kind: optionalString(args['kind']), reason: optionalString(args['reason']), acceptLoss: args['accept_loss'] === true },
      );
      return teleportReply(result).join('\n');
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
    if (lines) return shownScreen(await herdr.paneRead({ paneId: child.paneId, source: 'recent_unwrapped', lines }));
    if (hostOf(child) !== LOCAL_HOST) return readRemoteChild(ctx, child, herdr);
    // A working directory that is gone, or a retirement, comes first, in one line.
    const note = goneCwdLine(child, ctx.retireOps ?? realRetireOps()) ?? (child.retireOutcome ? retireLine(child) : undefined);
    if (note) return `${note}\n${await readLocalChild(ctx, child, herdr)}`;
    return readLocalChild(ctx, child, herdr);
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
    return (await messageChild({ herdr, parentId: ctx.parentId, from: senderName(record), child, text, inbox: ctx.inbox })).text;
  }

  if (name === 'agent_stop') {
    if (!args['force'] && (child.lastStatus === 'working' || child.lastStatus === 'blocked')) {
      // Pane feature: agent_stop shows the parent what the busy child is doing.
      const tail = shownScreen(await herdr.paneRead({ paneId: child.paneId, source: 'recent_unwrapped', lines: 20 }).catch(() => BLANK_SCREEN));
      return `${child.name} is ${child.lastStatus}, so agent_stop refused to close it. Pass force to close it anyway.\n${tail}`;
    }
    // The stop retires the child: the intent is written before the tab closes,
    // and the daemon removes the worktree after it, never the child. Issue #143.
    const retireOps = ctx.retireOps ?? realRetireOps();
    const leftAlone = await retireOnStop(ctx.parentId, child, retireOps).catch((error: unknown) => `Retirement could not read its working directory ${child.cwd}, so it leaves it in place: ${(error as Error).message}`);
    if (child.tabId) await herdr.tabClose(child.tabId);
    else await herdr.paneClose(child.paneId);
    updateChild(ctx.parentId, child.id, (entry) => {
      runEnds(entry, { at: new Date().toISOString() });
    });
    // A brief nothing shows the child read stays, so a resume can still hand it over.
    removeChildFiles(child.id, hostOf(child) === LOCAL_HOST ? child.cwd : undefined, { briefs: !keepsBriefs(child) });
    // A workspace Bellwether made for the child closes once nothing is left in it.
    const released = await releaseWorkspace(herdr, child).catch((error: unknown) => {
      ctx.log?.(`agent_stop: could not check ${child.name}'s workspace ${child.workspaceId}: ${(error as Error).message}`);
      return undefined;
    });
    const roomNote = released === 'kept' ? ` Its workspace ${workspaceName(child)} stays open, because it still holds another tab.` : '';
    // The stop marked the exit, so the pane_closed that follows finds it
    // recorded. The cleanup starts here as well, and the first to see the pane
    // gone does it, once. Issue #120.
    // The reply waits a bounded time for that pass, so it can say what became of the worktree.
    let waited: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([ctx.watcher.childStopped(child.id), new Promise<void>((done) => (waited = setTimeout(done, STOP_RETIRE_WAIT_MS)))]);
    clearTimeout(waited);
    const settled = readParent(ctx.parentId)?.children.find((entry) => entry.id === child.id) ?? child;
    const lines = [leftAlone ?? retireLine(settled), farWorktreesLine(settled)].filter(Boolean);
    const retireNote = lines.length ? ` ${lines.join(' ')}` : '';
    // A child on another machine has its brief, config and relay record there.
    if (hostOf(child) !== LOCAL_HOST && ctx.remote) {
      try {
        await ctx.remote.cleanup(child);
      } catch (error) {
        ctx.log?.(`agent_stop: could not remove ${child.name}'s files on machine ${hostOf(child)}: ${(error as Error).message}`);
        return `Closed ${child.name}.${roomNote}${retireNote} Its brief, MCP config and relay record on machine ${hostOf(child)} could not be removed, and stay there until \`bellwether relay-cleanup --child ${child.id}\` runs on that machine: ${(error as Error).message}`;
      }
    }
    return `Closed ${child.name}.${roomNote}${retireNote}`;
  }

  throw new UnknownTool(name);
}

/** A local child's last message, from its harness's store or transcript, or its screen when neither holds one yet. */
async function readLocalChild(ctx: ToolContext, child: ChildRecord, herdr: HerdrClient): Promise<string> {
  // A harness whose conversation sits in a store of its own, such as
  // OpenCode's, answers from there, not from a transcript file.
  const conversation = harnessFor(child.kind)?.conversation;
  if (conversation?.lastMessage) {
    const answer = conversation.lastMessage(child);
    if (answer) return answer;
    const pending = conversation.pending?.(child);
    if (pending) {
      if (!pending.withScreen) return pending.note;
      // Pane feature: agent_read for a child whose store holds no answer yet.
      const screen = shownScreen(await herdr.paneRead({ paneId: child.paneId, source: 'recent_unwrapped', lines: 40 }).catch(() => BLANK_SCREEN));
      return screen ? `${pending.note}\n${screen}` : pending.note;
    }
  }
  const transcript = child.transcript ?? transcriptFromSession(ctx.parentId, child);
  const message = transcript ? lastAssistantMessage(transcript) : undefined;
  if (message) return message;
  // Pane feature: agent_read for a child whose transcript holds no message yet.
  return shownScreen(await herdr.paneRead({ paneId: child.paneId, source: 'recent_unwrapped', lines: 40 }));
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

/** Who a message comes from, as the child reads it: the sender's own name under its parent, or its session. */
function senderName(record: { harness: string; session: string; childId?: string }): string {
  const own = record.childId ? localParentOf(record.childId)?.child.name : undefined;
  return own ? `your parent, ${own}` : `your parent, ${record.harness} session ${record.session}`;
}

/**
 * Give a child the answer to its depth request the way agent_send gives a
 * message: into its session where it can, typed into its pane otherwise. The
 * grant itself is already on the record before the child is told, so the
 * path changes only how the child hears of it, not what it means. The answer
 * comes from the chain above it, which its own parent started. A child that
 * has gone keeps the answer on its record.
 */
async function tellChild(ctx: ToolContext, child: ChildRecord, text: string): Promise<void> {
  if (child.exitedAt || !child.paneId) return;
  const parentId = localParentOf(child.id)?.parent.id ?? ctx.parentId;
  try {
    const outcome = await messageChild({ herdr: await clientFor(ctx, hostOf(child)), parentId, from: 'Bellwether depth grant', child, text, inbox: ctx.inbox });
    ctx.log?.(`depth: told ${child.name} by ${outcome.message.path === 'session' ? `its session (${outcome.message.via})` : `keystrokes in pane ${child.paneId} (${outcome.message.reason})`}, as message ${outcome.message.id}`);
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
    const screen = shownScreen(await herdr.paneRead({ paneId: child.paneId, source: 'recent_unwrapped', lines: 40 }).catch(() => BLANK_SCREEN));
    if (screen) return screen;
  }
  return `${why} It never reported${child.exitedAt ? ', and it has exited, so there is no screen to read' : ''}.`;
}

export function hostEnv(): Record<string, string> {
  return { host: os.hostname() };
}

/**
 * What the reply says when a resume handed over a brief the child had not
 * read: why, and the file that still holds the first one (issue #132).
 */
function repeatedBriefNote(child: ChildRecord, brief: NextBrief | undefined): string | undefined {
  if (!brief?.repeats) return undefined;
  const first = Math.min(...(brief.brief.carries ?? [brief.repeats.n]));
  const original = child.briefs?.find((entry) => entry.n === first)?.file ?? brief.repeats.file;
  const how = brief.reused ? `Bellwether handed that brief over again, from ${brief.brief.file}` : `Bellwether put that brief ahead of your prompt in ${brief.brief.file}`;
  return `${child.name} had not read the brief it started on: its record shows no report and no finished turn since. ${how}. Its first brief stays at ${original}.`;
}

/**
 * Why the daemon on another machine cannot put a teleport's notice into the
 * child's session there, as the relay connection to it last reported: a
 * Bellwether that predates relay-message. A machine with no connection yet
 * says nothing here, and its answer to the notice itself decides.
 */
export function farInboundGap(host: string, state: RelayHostState | undefined): string | undefined {
  if (host === LOCAL_HOST || !state?.farVersion) return undefined;
  const since = featureNamed('relay-message')?.version;
  if (since && (compareVersions(state.farVersion, since) ?? 0) < 0) return predates(state, 'relay-message');
  return undefined;
}
