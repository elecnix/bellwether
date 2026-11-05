// Watch one or more herdr panes and print what herdr reports at every status
// change, including completion_seq. This answers probe 5: the pane fields are
// the evidence, so the probe records them rather than describing them.
//
//   node scripts/herdr-watch.ts --session bw-probe --pane w1:p4 --seconds 60
//
// It prints one JSON line per observation, so a reader can diff them.
import process from 'node:process';
import { HerdrClient, type HerdrPane } from '../src/core/herdr-client.ts';

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const session = flag('session') ?? 'bw-probe';
const panes = process.argv
  .map((value, index) => (value === '--pane' ? process.argv[index + 1] : undefined))
  .filter((value): value is string => typeof value === 'string');
const seconds = Number.parseInt(flag('seconds') ?? '60', 10);

if (panes.length === 0) throw new Error('give at least one --pane');

const client = new HerdrClient({ session });

const FIELDS = ['pane_id', 'agent', 'name', 'agent_status', 'completion_seq', 'state_change_seq', 'revision', 'agent_session', 'interactive_ready', 'screen_detection_skipped'] as const;

function line(source: string, raw: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}): void {
  const picked: Record<string, unknown> = { at: new Date().toISOString(), source, ...extra };
  for (const field of FIELDS) {
    if (raw && field in raw) picked[field] = raw[field];
  }
  if (raw && raw['agent_session'] === undefined) picked['agent_session'] = null;
  if (raw && raw['completion_seq'] === undefined) picked['completion_seq'] = null;
  if (raw && raw['state_change_seq'] === undefined) picked['state_change_seq'] = null;
  console.log(JSON.stringify(picked));
}

async function pane(paneId: string): Promise<Record<string, unknown> | undefined> {
  try {
    const result = await client.request('pane.get', { pane_id: paneId });
    const raw = typeof result === 'object' && result !== null && 'pane' in result ? ((result as { pane: Record<string, unknown> }).pane) : undefined;
    if (!raw) return undefined;
    // agent.get carries state_change_seq where pane.get leaves it out, and it
    // also carries the harness session path, so a probe reads both surfaces.
    try {
      const agentResult = await client.request('agent.get', { target: paneId });
      const agent = typeof agentResult === 'object' && agentResult !== null && 'agent' in agentResult ? ((agentResult as { agent: Record<string, unknown> }).agent) : undefined;
      if (agent && typeof agent === 'object') return { ...raw, ...agent, agent_from: 'agent.get' };
    } catch {
      // a pane with no agent answers pane.get only
    }
    return raw;
  } catch (error) {
    return { error: String(error) };
  }
}

const controller = new AbortController();
const subscription = await client.subscribe(
  panes.map((paneId) => ({ type: 'pane.agent_status_changed', pane_id: paneId })),
  (event) => {
    void (async () => {
      const current = await pane(String(event.data['pane_id'] ?? ''));
      line('event', current, { event: event.event, event_data: event.data });
    })();
  },
  controller.signal,
  8000,
);
line('subscribed', undefined, { panes, socket: client.socketPath });

// A pane read on a fixed beat is a probe, not the status source the design
// forbids. It records the fields between events, so a null that never changes
// is distinguishable from a null that was replaced.
const timer = setInterval(() => {
  void (async () => {
    for (const paneId of panes) line('poll', await pane(paneId));
  })();
}, 4000);

await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
clearInterval(timer);
subscription.close();
process.exit(0);
