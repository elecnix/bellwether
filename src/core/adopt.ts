// Adopting a pane. An agent started by hand, or by a script such as
// herdr-spawn.sh, never passed through agent_spawn, so no parent watches it.
// agent_adopt registers it as a child of this parent, and the watcher picks it
// up on its next pass like any spawned child.
import type { HerdrClient } from './herdr-client.ts';
import { LOCAL_HOST } from './machine.ts';
import { newChildId } from './outbox.ts';
import { upsertChild, watcherOfPane } from './registry.ts';
import { AGENT_KINDS, harnessOf, herdrLink } from './spawn.ts';
import { resolveTranscript } from './transcript.ts';
import type { ChildRecord, ParentRecord } from './types.ts';
import { resolveInactiveMs } from './inactivity.ts';

export interface AdoptOptions {
  /** A pane id, or the name of a live agent, on the host. */
  target: string;
  host?: string;
  /** The handle to use for the child. Defaults to the agent's herdr name. */
  name?: string;
  stuckMinutes?: number;
}

export interface AdoptResult {
  child: ChildRecord;
  link: string;
  /** True when this parent already watched the pane. */
  already: boolean;
}

export async function adoptPane(client: HerdrClient, parent: ParentRecord, options: AdoptOptions, signal?: AbortSignal): Promise<AdoptResult> {
  const host = options.host ?? LOCAL_HOST;
  const agents = await client.agentList(signal);
  const byPane = agents.find((pane) => pane.paneId === options.target);
  const byName = agents.filter((pane) => pane.name === options.target);
  if (!byPane && byName.length > 1) throw new Error(`More than one live agent on ${host} is named ${options.target}. Adopt it by pane id: ${byName.map((pane) => pane.paneId).join(', ')}.`);
  const pane = byPane ?? byName[0];
  if (!pane || !pane.agent) {
    const panes = await client.paneList(signal).catch(() => []);
    const bare = panes.find((entry) => entry.paneId === options.target);
    if (bare) throw new Error(`Pane ${options.target} on ${host} holds no agent herdr recognizes, so there is nothing to adopt.`);
    throw new Error(`No pane or live agent on ${host} matches ${options.target}.`);
  }
  if (!(AGENT_KINDS as readonly string[]).includes(pane.agent)) throw new Error(`Pane ${pane.paneId} on ${host} runs ${pane.agent}, which is not an agent kind Bellwether supervises.`);
  if (host === LOCAL_HOST && pane.paneId === parent.paneId) throw new Error('A session cannot adopt its own pane.');

  const owner = watcherOfPane(host, pane.paneId);
  if (owner && owner.parent.id === parent.id) return { child: owner.child, link: herdrLink('pane', pane.paneId), already: true };
  if (owner) throw new Error(`Pane ${pane.paneId} on ${host} is already a child of ${owner.parent.id} as ${owner.child.name}, so this session cannot adopt it.`);

  const now = new Date().toISOString();
  const kind = pane.agent;
  const harness = harnessOf(kind);
  const child: ChildRecord = {
    id: newChildId(),
    name: options.name ?? pane.name ?? pane.label ?? pane.paneId,
    kind,
    harness,
    paneId: pane.paneId,
    tabId: pane.tabId,
    workspaceId: pane.workspaceId,
    host,
    origin: 'adopt',
    cwd: pane.cwd,
    startedAt: now,
    lastStatus: pane.agentStatus,
    statusChangedAt: now,
    completionSeq: pane.completionSeq,
    session: pane.agentSessionId ? { kind: pane.agentSessionId.includes('/') ? 'path' : 'id', value: pane.agentSessionId } : undefined,
    // A remote child's transcript sits on its own machine's disk.
    transcript: host === LOCAL_HOST ? resolveTranscript(harness, pane.agentSessionId, pane.cwd) : undefined,
    lastBusyAt: now,
    depth: parent.depth + 1,
    stuckMs: options.stuckMinutes === undefined ? undefined : Math.max(1_000, Math.round(options.stuckMinutes * 60_000)),
    inactiveMs: resolveInactiveMs(undefined),
  };
  upsertChild(parent.id, child);
  return { child, link: herdrLink('pane', child.paneId), already: false };
}
