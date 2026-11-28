// Two or three Bellwether homes in one root, for the claims cases of issue
// #211: the pane machine, which holds the panes and the claims of parents on
// other machines, and far parents, each on a machine of its own. `on(home, fn)`
// runs fn with that home current. The pane machine is "pane-box" to a far
// parent, and "local" to itself.
import fs from 'node:fs';
import path from 'node:path';
import { adoptPane } from '../../src/core/adopt.ts';
import type { HerdrClient, HerdrPane } from '../../src/core/herdr-client.ts';
import { claimPane } from '../../src/core/pane-claims.ts';
import { emptyParent, listParents, saveParent } from '../../src/core/registry.ts';
import { listRelayRecords } from '../../src/core/relay-records.ts';
import { isolate } from './isolated.ts';

export const PANE = 'w1:p5';
export const PANE_HOST = 'pane-box';

export function machines(t: { after: (fn: () => void) => void }) {
  const { root } = isolate(t, 'claims-model-');
  const home = (name: string) => {
    const dir = path.join(root, name, '.bellwether');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  return { pane: home('pane'), f1: home('f1'), f2: home('f2') };
}

export function on<T>(home: string, fn: () => T): T {
  const saved = process.env['BELLWETHER_HOME'];
  process.env['BELLWETHER_HOME'] = home;
  try {
    return fn();
  } finally {
    process.env['BELLWETHER_HOME'] = saved;
  }
}

/** herdr on the pane machine: pane x runs `state.session`. */
export function herdr(state: { session: string }): HerdrClient {
  const pane = (): HerdrPane => ({ paneId: PANE, workspaceId: 'w1', tabId: 'w1:t5', terminalId: 't5', focused: false, revision: 0, agent: 'claude', name: 'mate', agentStatus: 'idle', agentSessionId: state.session });
  return { agentList: async () => [pane()], paneList: async () => [pane()] } as unknown as HerdrClient;
}

export function newParent(home: string, name: string): string {
  return on(home, () => saveParent(emptyParent('claude-code', name, '/w', {})).id);
}

/**
 * FarAdopt(p, x): adoptPane in the far parent's home, whose claim callback is
 * claimPane in the pane machine's home (what relay-adopt runs, server.ts:725).
 * `replyLost` throws after claimPane saved the claim, as the relay-links.ts:257 timeout does.
 */
export async function farAdopt(parentHome: string, parentId: string, paneHome: string, client: HerdrClient, replyLost = false) {
  const saved = process.env['BELLWETHER_HOME'];
  process.env['BELLWETHER_HOME'] = parentHome;
  try {
    const parent = listParents().find((entry) => entry.id === parentId)!;
    return await adoptPane(client, parent, {
      target: PANE,
      host: PANE_HOST,
      claim: async (_host, claim) => {
        const answer = on(paneHome, () => claimPane(claim));
        if (replyLost) throw new Error(`machine ${PANE_HOST} did not answer an adoption within 5000 ms`);
        return answer;
      },
    });
  } finally {
    process.env['BELLWETHER_HOME'] = saved;
  }
}

/** LocalAdopt(p, x): adoptPane on the pane machine for a parent there. */
export async function localAdopt(paneHome: string, parentId: string, client: HerdrClient) {
  const saved = process.env['BELLWETHER_HOME'];
  process.env['BELLWETHER_HOME'] = paneHome;
  try {
    const parent = listParents().find((entry) => entry.id === parentId)!;
    return await adoptPane(client, parent, { target: PANE });
  } finally {
    process.env['BELLWETHER_HOME'] = saved;
  }
}

/** Live adopted children on pane x, per parent, in one machine's registry. `host` is how that machine names the pane machine. */
export function liveOnPane(home: string, host: string): { parentId: string; childId: string; session?: string }[] {
  return on(home, () =>
    listParents().flatMap((parent) =>
      parent.children.filter((child) => child.origin === 'adopt' && !child.exitedAt && child.paneId === PANE && (child.host ?? 'local') === host).map((child) => ({ parentId: parent.id, childId: child.id, session: child.session?.value })),
    ),
  );
}

export function farRecords(paneHome: string) {
  return on(paneHome, () => listRelayRecords().filter((record) => record.adopted && !record.retiredAt && record.paneId === PANE));
}
