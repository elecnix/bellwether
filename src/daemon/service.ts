// A parent service: everything the daemon keeps for one parent session. The
// herdr-backed service wraps the same tool list, watcher and outbox the
// adapters used to run in-process; the daemon now runs it once for every
// client of the session, and tests pass a fake in its place.
import { HerdrClient } from '../core/herdr-client.ts';
import { emptyParent, parentId, readParent, saveParent } from '../core/registry.ts';
import { Watcher } from '../core/watcher.ts';
import { runBellwetherTool, type ToolContext } from '../integrations/tools.ts';
import type { OutboxEntry } from '../core/types.ts';
import type { ParentHello } from './protocol.ts';

export interface ParentService {
  /** Run one Bellwether tool for a client, and return its text. */
  tool(name: string, args: Record<string, unknown>): Promise<string>;
  /** Mark receipts read, which settles their outbox entries. */
  markRead(receipts: string[]): void;
  /** Subscribe to new events. One handler per service, set by the daemon. */
  onEvents(handler: (entries: OutboxEntry[]) => void): void;
  /** Unread entries, ready to send again after a reconnect. */
  pending(): OutboxEntry[];
  /** Report one pane's status changes, and stop when the returned function runs. */
  watchPane(paneId: string, handler: (status: string) => void): () => void;
  stop(): void;
}

export type ServiceFactory = (parent: ParentHello, id: string) => ParentService;

/** The herdr-backed service, one per parent session. */
export function createHerdrService(parent: ParentHello, id: string): ParentService {
  const existing = readParent(id);
  const record = existing ?? saveParent(emptyParent(parent.harness, parent.session, parent.cwd, { host: parent.host, paneId: parent.paneId, workspaceId: parent.workspaceId, depth: parent.depth }));
  if (!existing) saveParent(record);
  const client = new HerdrClient({ socketPath: parent.herdrSocket });
  let handler: ((entries: OutboxEntry[]) => void) | undefined;
  const watcher = new Watcher({ client, parentId: record.id, onEntries: (entries) => handler?.(entries) });
  const context: ToolContext = { client, parentId: record.id, watcher };
  const paneWatches = new Set<{ close: () => void }>();
  watcher.start();
  return {
    tool: (name, args) => runBellwetherTool(context, name, args),
    markRead: (receipts) => {
      for (const receipt of receipts) watcher.markRead(receipt);
    },
    onEvents: (next) => {
      handler = next;
    },
    pending: () => watcher.outboxEntries().filter((entry) => !entry.read).map((entry) => ({ ...entry, deliveredAt: undefined })),
    watchPane: (paneId, handler) => {
      const controller = new AbortController();
      const watch = { close: () => controller.abort() };
      paneWatches.add(watch);
      void client
        .subscribe([{ type: 'pane.agent_status_changed', pane_id: paneId }], (event) => {
          const id = event.data['pane_id'];
          const status = event.data['agent_status'];
          if (id === paneId && typeof status === 'string') handler(status);
        }, controller.signal)
        .catch((error: unknown) => {
          paneWatches.delete(watch);
          handler(`unavailable: ${String(error)}`);
        });
      return () => {
        paneWatches.delete(watch);
        controller.abort();
      };
    },
    stop: () => {
      for (const watch of paneWatches) watch.close();
      paneWatches.clear();
      watcher.stop();
    },
  };
}

export const defaultServiceFactory: ServiceFactory = createHerdrService;

/** The parent id a hello stands for, so a resumed session finds its children. */
export function parentIdOf(parent: ParentHello): string {
  return parentId(parent.harness, parent.session);
}
