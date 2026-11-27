// The herdr calls a typed start makes, answered in memory, for a test that
// stands a plain object in for the herdr client. A start types its launch
// line with sendInput and waits for herdr's pane.agent_detected, so typing a
// line here detects the harness named after `command` or the launcher, and
// reports it idle at its prompt.
import { shellWords } from './fake-world.ts';

type Handler = (event: { event: string; data: Record<string, unknown> }) => void;

export interface TypedLaunchStub {
  /** Every line typed into a pane, in order. */
  readonly typed: { paneId: string; line: string }[];
  subscribe(filters: unknown, onEvent: Handler, signal?: AbortSignal): Promise<{ closed: Promise<void>; close(): void }>;
  sendInput(paneId: string, text: string, keys: string[]): Promise<void>;
  agentRename(): Promise<void>;
  /** agent.get finds an agent with no name, as herdr reports one it detected. */
  request(method: string): Promise<unknown>;
  /** A screen with no error on it. */
  paneRead(): Promise<string>;
}

export function typedLaunchStub(): TypedLaunchStub {
  const handlers = new Set<Handler>();
  const typed: { paneId: string; line: string }[] = [];
  return {
    typed,
    async subscribe(_filters, onEvent, signal) {
      handlers.add(onEvent);
      const close = (): void => {
        handlers.delete(onEvent);
      };
      signal?.addEventListener('abort', close, { once: true });
      return { closed: new Promise<void>(() => {}), close };
    },
    async sendInput(paneId, text, keys) {
      if (!keys.includes('Enter')) return;
      typed.push({ paneId, line: text });
      const words = shellWords(text);
      const agent = words[0] === 'command' ? words[1] : words[0];
      setTimeout(() => {
        for (const handler of [...handlers]) handler({ event: 'pane_agent_detected', data: { pane_id: paneId, agent } });
        // herdr then reports the harness at its prompt.
        for (const handler of [...handlers]) handler({ event: 'pane_agent_status_changed', data: { pane_id: paneId, agent, agent_status: 'idle' } });
      }, 1);
    },
    async agentRename() {},
    async paneRead() {
      return '';
    },
    async request(method) {
      return method === 'agent.get' ? { type: 'agent_info', agent: {} } : {};
    },
  };
}
