// Prompting a live child. agent_send and a spawn that finds its resume target
// alive both go through here, so a blocked child gets the same answer from each.
import { HerdrApiError, type HerdrClient } from './herdr-client.ts';
import type { ChildRecord } from './types.ts';

/** Submit a prompt to a child's pane, or return the dialog that blocks it. */
export async function promptChild(herdr: HerdrClient, child: Pick<ChildRecord, 'name' | 'paneId' | 'lastStatus'>, text: string): Promise<string> {
  try {
    await herdr.agentPrompt(child.paneId, text);
    return `Prompted ${child.name}.`;
  } catch (error) {
    if (error instanceof HerdrApiError && child.lastStatus === 'blocked') {
      const dialog = await herdr.paneRead({ paneId: child.paneId, source: 'detection', lines: 30 }).catch(() => '');
      return `herdr refused the prompt because ${child.name} is blocked. The dialog:\n${dialog.trim()}\n\nReply with agent_send keys, for example ["enter"] or ["down","enter"].`;
    }
    throw error;
  }
}
