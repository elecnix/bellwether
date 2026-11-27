// A small herdr world for the fake socket: tab.create makes a pane, agent.start
// puts an agent in it with a session, and the list and snapshot methods report
// what exists. A resume flag in the start arguments becomes the pane's session,
// the way a harness reopens the session it was asked for.
import type { RecordedRequest } from './fake-herdr.ts';

export interface FakePane {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  terminal_id: string;
  agent_status: 'idle' | 'working' | 'blocked' | 'done' | 'unknown';
  agent?: string;
  name?: string;
  /** The tab label herdr reports for the pane. */
  label?: string;
  cwd?: string;
  agent_session?: { agent: string; kind: 'id' | 'path'; source: string; value: string };
  /** The arguments the agent started with. */
  args?: string[];
  /** For an agent started through a route: the words typed before the harness name, and the assignments in front of them. */
  launcher?: string[];
  assignments?: string[];
  /** The line typed into the pane, as herdr received it. */
  typed?: string;
  /** What pane.read shows. */
  screen?: string;
}

/** Claude Code's development-channel confirmation, as a child paints it. */
export const CHANNEL_DIALOG = [
  'WARNING: Loading development channels',
  '',
  '--dangerously-load-development-channels is for local channel development only.',
  'Channels: server:bellwether',
  '',
  ' ❯ 1. I am using this for local development',
  '   2. Exit',
].join('\n');

const READY = '╭──────────╮\n│ >        │\n╰──────────╯';

export interface FakeWorld {
  /** The raw result for a request, an `{error}` object, or undefined. */
  answer(request: RecordedRequest): unknown;
  panes: Map<string, FakePane>;
  /** Where the world sends status events: set it to the fake socket's send. */
  emit: (frame: unknown) => void;
  /** Called on every agent.start, before the world answers it. */
  onStart?: (pane: FakePane) => void;
  /** Put a pane in the world, with or without an agent. */
  add(pane: Partial<FakePane> & { pane_id: string }): FakePane;
  /** An answer in the fake socket's `respond` shape, or undefined for the default. */
  respond(request: RecordedRequest): { result: unknown } | { error: { code: string; message: string } } | undefined;
}

const HARNESSES = new Set(['claude', 'pi', 'codex', 'opencode', 'cline']);

/**
 * Split a line into words as a POSIX shell does for the forms a launch line
 * uses: spaces, single quotes, double quotes kept literal, and backslashes.
 * Command substitution is not run: `NAME="$(cat 'f')"` stays one word.
 */
export function shellWords(line: string): string[] {
  const words: string[] = [];
  let word = '';
  let started = false;
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] as string;
    if (quote) {
      if (char === quote) quote = undefined;
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === '\\' && index + 1 < line.length) {
      index += 1;
      word += line[index];
      started = true;
    } else if (/\s/.test(char)) {
      if (started) words.push(word);
      word = '';
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (started) words.push(word);
  return words;
}

export function fakeWorld(workspace = 'w1'): FakeWorld {
  const panes = new Map<string, FakePane>();
  const labels = new Map<string, string>();
  let next = 10;
  const agents = (): FakePane[] => [...panes.values()].filter((pane) => pane.agent);
  const add = (pane: Partial<FakePane> & { pane_id: string }): FakePane => {
    const full: FakePane = { tab_id: `${workspace}:t-${pane.pane_id}`, workspace_id: workspace, terminal_id: `term-${pane.pane_id}`, agent_status: pane.agent ? 'idle' : 'unknown', ...pane };
    panes.set(full.pane_id, full);
    return full;
  };
  const status = (world: FakeWorld, pane: FakePane, agentStatus: FakePane['agent_status']): void => {
    pane.agent_status = agentStatus;
    setTimeout(() => world.emit({ event: 'pane_agent_status_changed', data: { pane_id: pane.pane_id, agent_status: agentStatus } }), 20);
  };
  /** Put an agent in a pane, the way agent.start or a typed launch does. */
  const start = (world: FakeWorld, pane: FakePane, kind: string, args: string[]): void => {
    const flag = args.findIndex((arg) => arg === '--resume' || arg === '--session');
    const value = flag >= 0 ? String(args[flag + 1]) : `fresh-${pane.pane_id}`;
    pane.agent = kind;
    pane.args = args;
    pane.agent_session = { agent: pane.agent, kind: value.includes('/') ? 'path' : 'id', source: `herdr:${pane.agent}`, value };
    world.onStart?.(pane);
    // A Claude Code session loaded with the development channel opens on
    // the confirmation and waits; one started without the flag does not.
    if (pane.agent === 'claude' && args.some((arg) => arg.startsWith('--dangerously-load-development-channels'))) {
      pane.screen = CHANNEL_DIALOG;
      status(world, pane, 'blocked');
    } else {
      pane.screen = READY;
      pane.agent_status = 'idle';
    }
  };
  return {
    panes,
    emit: () => {},
    add,
    respond(request) {
      const answer = this.answer(request);
      if (answer === undefined) return undefined;
      if (typeof answer === 'object' && answer !== null && 'error' in answer) return answer as { error: { code: string; message: string } };
      return { result: answer };
    },
    answer(request: RecordedRequest): unknown {
      const params = request.params;
      switch (request.method) {
        case 'tab.create': {
          const id = `${workspace}:p${next}`;
          const tab = `${workspace}:t${next}`;
          next += 1;
          add({ pane_id: id, tab_id: tab, cwd: typeof params['cwd'] === 'string' ? params['cwd'] : undefined });
          return { type: 'tab_created', tab: { tab_id: tab }, root_pane: { pane_id: id } };
        }
        case 'workspace.create': {
          // herdr makes a workspace with one tab and its root pane. The
          // workspace lives as long as one of its panes does.
          const id = `w${next}`;
          next += 1;
          const label = typeof params['label'] === 'string' ? params['label'] : id;
          labels.set(id, label);
          add({ pane_id: `${id}:p1`, tab_id: `${id}:t1`, workspace_id: id, cwd: typeof params['cwd'] === 'string' ? params['cwd'] : undefined });
          return { type: 'workspace_created', workspace: { workspace_id: id, label }, tab: { tab_id: `${id}:t1`, workspace_id: id }, root_pane: { pane_id: `${id}:p1` } };
        }
        case 'workspace.list': {
          const ids = [...new Set([workspace, ...[...panes.values()].map((pane) => pane.workspace_id)])];
          return { type: 'workspace_list', workspaces: ids.map((id) => ({ workspace_id: id, label: labels.get(id) ?? id, tab_count: new Set([...panes.values()].filter((pane) => pane.workspace_id === id).map((pane) => pane.tab_id)).size })) };
        }
        case 'agent.start': {
          const pane = panes.get(String(params['pane_id']));
          if (!pane) return { error: { code: 'pane_not_found', message: 'no such pane' } };
          const args = Array.isArray(params['args']) ? (params['args'] as string[]) : [];
          pane.name = String(params['name']);
          start(this, pane, String(params['kind']), args);
          return { type: 'agent_started' };
        }
        case 'pane.send_input': {
          // A line typed at the shell prompt: the shell splits it into words,
          // and the first harness name among them is the program herdr detects
          // behind whatever launcher runs it.
          const pane = panes.get(String(params['pane_id']));
          if (!pane) return { error: { code: 'pane_not_found', message: 'no such pane' } };
          const text = typeof params['text'] === 'string' ? params['text'] : '';
          const keys = Array.isArray(params['keys']) ? (params['keys'] as string[]) : [];
          if (pane.agent || !keys.includes('Enter')) return { type: 'ok' };
          const words = shellWords(text);
          const assignments: string[] = [];
          while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] as string)) assignments.push(words.shift() as string);
          const at = words.findIndex((word, index) => index > 0 && HARNESSES.has(word));
          if (at < 0) return { type: 'ok' };
          pane.typed = text;
          pane.assignments = assignments;
          pane.launcher = words.slice(0, at);
          start(this, pane, words[at] as string, words.slice(at + 1));
          setTimeout(() => this.emit({ event: 'pane_agent_detected', data: { pane_id: pane.pane_id, agent: pane.agent, workspace_id: pane.workspace_id } }), 20);
          return { type: 'ok' };
        }
        case 'agent.rename': {
          const pane = panes.get(String(params['target']));
          if (!pane?.agent) return { error: { code: 'agent_not_found', message: 'no agent in that pane' } };
          pane.name = String(params['name']);
          return { type: 'ok' };
        }
        case 'pane.read': {
          const pane = panes.get(String(params['pane_id']));
          return { type: 'pane_read', read: { pane_id: String(params['pane_id']), source: String(params['source']), format: 'text', text: pane?.screen ?? '' } };
        }
        case 'agent.send_keys': {
          const pane = panes.get(String(params['target']));
          const keys = Array.isArray(params['keys']) ? (params['keys'] as string[]) : [];
          if (pane?.screen === CHANNEL_DIALOG && keys.includes('Enter')) {
            pane.screen = READY;
            status(this, pane, 'idle');
          }
          return { type: 'ok' };
        }
        case 'agent.get': {
          const pane = panes.get(String(params['target']));
          if (!pane?.agent) return { error: { code: 'agent_not_found', message: 'no agent in that pane' } };
          return { type: 'agent_info', agent: pane };
        }
        case 'agent.list':
          return { type: 'agent_list', agents: agents() };
        case 'pane.list':
          return { type: 'pane_list', panes: [...panes.values()] };
        case 'session.snapshot':
          return { type: 'session_snapshot', snapshot: { panes: [...panes.values()], agents: agents() } };
        case 'pane.close': {
          // A pane close makes herdr send pane_closed for that pane.
          const pane = panes.get(String(params['pane_id']));
          if (!pane) return { error: { code: 'pane_not_found', message: 'no such pane' } };
          panes.delete(pane.pane_id);
          setTimeout(() => this.emit({ event: 'pane_closed', data: { pane_id: pane.pane_id } }), 20);
          return { type: 'ok' };
        }
        case 'tab.close': {
          // A tab close makes herdr send tab_closed and no pane event, which is
          // what a watcher sees when the daemon closes a child's tab.
          const closed = [...panes.values()].filter((pane) => pane.tab_id === params['tab_id']);
          for (const pane of closed) panes.delete(pane.pane_id);
          for (const tab of new Set(closed.map((pane) => pane.tab_id))) setTimeout(() => this.emit({ event: 'tab_closed', data: { tab_id: tab } }), 20);
          return { type: 'ok' };
        }
        default:
          return undefined;
      }
    },
  };
}
