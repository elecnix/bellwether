// A spawn with a resume target acts as a message that resumes. The caller says
// what it wants to tell a child, and this decides how it gets there: a child
// whose session herdr still shows gets the prompt as an ordinary message, and a
// child herdr no longer knows comes back in a new tab with its session's resume
// flag, under the same child id. herdr decides which, not the registry, because
// the registry can be stale. One lock per child covers the decision and the
// resume, so two callers bring a child back once.
import path from 'node:path';
import type { HerdrClient, HerdrPane } from './herdr-client.ts';
import { withChildLock } from './child-lock.ts';
import { LOCAL_HOST, hostOf } from './machine.ts';
import { readParent, updateChild } from './registry.ts';
import { findResumable, holdsSession, resumeArgs, resumeChild, sessionOf, type HarnessSession, type ResumeOptions } from './resume.ts';
import { herdrLink } from './spawn.ts';
import { promptChild } from './send.ts';
import type { ChildRecord } from './types.ts';

export interface SpawnResumeRequest extends Omit<ResumeOptions, 'workspaceId'> {
  /** A child id or name, a session id or transcript path, or a live agent's name. */
  target: string;
  /** For a session no child ran: the harness, handle, directory and machine. */
  kind?: string;
  name?: string;
  cwd?: string;
  host?: string;
}

export type SpawnResumeResult =
  | {
      action: 'messaged';
      child: ChildRecord;
      /** What herdr said to the prompt, or that there was none to send. */
      reply: string;
      link: string;
      /** Set when herdr contradicted the registry, saying what Bellwether did about it. */
      corrected?: string;
    }
  | {
      action: 'resumed';
      child: ChildRecord;
      session: HarnessSession;
      link: string;
      corrected?: string;
      reportWarning?: string;
    };

function sessionTarget(value: string): HarnessSession {
  return { value, kind: value.includes('/') ? 'path' : 'id' };
}

function paneLabel(pane: HerdrPane): string {
  return `pane ${pane.paneId}${pane.name ? ` (${pane.name})` : ''}`;
}

export async function spawnResume(clientFor: (host: string) => Promise<HerdrClient>, parentId: string, request: SpawnResumeRequest, signal?: AbortSignal): Promise<SpawnResumeResult> {
  const first = readParent(parentId);
  if (!first) throw new Error(`No Bellwether registry for ${parentId}.`);
  const known = findResumable(first, request.target);
  const host = known ? hostOf(known) : (request.host ?? LOCAL_HOST);
  const client = await clientFor(host);
  const key = known ? known.id : `session-${path.basename(request.target, '.jsonl')}`;
  const label = known ? `${known.name} (child ${known.id})` : `Session ${request.target}`;

  return withChildLock(key, label, `resume of ${request.target}`, async () => {
    // Read the registry again under the lock: a caller that held it before
    // this one may have just brought the child back.
    const record = readParent(parentId) ?? first;
    const panes = await client.agentList(signal);
    const options: ResumeOptions = { prompt: request.prompt, model: request.model, args: request.args, focus: request.focus, startupTimeoutMs: request.startupTimeoutMs, redrawMs: request.redrawMs, registerRemote: request.registerRemote, cleanupRemote: request.cleanupRemote };

    if (!known) {
      const wanted = sessionTarget(request.target);
      const live = panes.find((pane) => pane.agent && (pane.paneId === request.target || pane.name === request.target || holdsSession(pane, wanted)));
      if (live) {
        throw new Error(`"${request.target}" is alive in ${paneLabel(live)} on ${host}, but it is not a child of this session, and Bellwether sends input only to panes this session started. Adopt it with agent_adopt, then call agent_spawn with resume again to message it.`);
      }
      if (!request.kind) {
        throw new Error(`"${request.target}" is neither a child of this session nor a live session on ${host}. Call agent_list to see this session's children, or pass kind (claude or pi) with resume to reopen a session id no child ran.`);
      }
      resumeArgs(request.kind, wanted);
      const resumed = await resumeChild(client, record, { session: wanted, kind: request.kind, name: request.name, cwd: request.cwd, host }, options, signal);
      return { action: 'resumed', child: resumed.child, session: resumed.session, link: resumed.link, ...(resumed.reportWarning ? { reportWarning: resumed.reportWarning } : {}) };
    }

    const child = record.children.find((entry) => entry.id === known.id) ?? known;
    const session = sessionOf(child);
    const holder = session ? panes.find((pane) => holdsSession(pane, session)) : undefined;

    if (holder && holder.paneId === child.paneId) {
      // Alive where this session put it: the prompt is an ordinary message.
      let corrected: string | undefined;
      if (child.exitedAt) {
        corrected = `The registry marked ${child.name} exited, but herdr shows its session ${session?.value} in its own pane ${child.paneId}, so Bellwether cleared the exit and treated it as alive.`;
        updateChild(parentId, child.id, (entry) => {
          delete entry.exitedAt;
          delete entry.exitCode;
        });
        delete child.exitedAt;
      }
      const reply = request.prompt ? await promptChild(client, child, request.prompt) : `${child.name} is alive in pane ${child.paneId}, and there was no prompt to send.`;
      return { action: 'messaged', child, reply, link: herdrLink('pane', child.paneId), corrected };
    }

    if (holder) {
      // The session runs, but in a pane this session did not start for it.
      throw new Error(`${child.name} (child ${child.id}) has its session ${session?.value} alive in ${paneLabel(holder)}, but this session last ran it in pane ${child.paneId}${child.exitedAt ? ' and the registry marked it exited' : ''}. Bellwether sends input only to panes this session started, so it neither messaged that pane nor opened a second copy. Adopt pane ${holder.paneId} with agent_adopt to take it over, or close that pane and call agent_spawn with resume again.`);
    }

    if (!session) {
      // With no session, herdr cannot say which conversation is the child's.
      // A running record whose pane still holds an agent of its kind is the
      // only case Bellwether can still trust.
      const own = panes.find((pane) => pane.paneId === child.paneId && pane.agent === child.kind);
      if (!child.exitedAt && own) {
        const reply = request.prompt ? await promptChild(client, child, request.prompt) : `${child.name} is alive in pane ${child.paneId}, and there was no prompt to send.`;
        return { action: 'messaged', child, reply, link: herdrLink('pane', child.paneId) };
      }
      resumeArgs(child.kind, { value: '', kind: 'id' });
      throw new Error(`${child.name} (child ${child.id}) has no recorded session, and herdr shows no running agent this session can tie to it in pane ${child.paneId}, so there is no conversation to reopen. Pass resume with the session id and kind to reopen it as a new child, or call agent_spawn without resume for a fresh one.`);
    }

    // herdr has no pane for the session: the child is retired.
    resumeArgs(child.kind, session);
    let corrected: string | undefined;
    if (!child.exitedAt) {
      corrected = `The registry still listed ${child.name} as running in pane ${child.paneId}, but herdr shows no pane holding its session ${session.value}, so Bellwether treated it as retired and resumed it.`;
      const at = new Date().toISOString();
      updateChild(parentId, child.id, (entry) => {
        entry.exitedAt = at;
      });
      child.exitedAt = at;
    }
    const resumed = await resumeChild(client, record, { child }, options, signal);
    return { action: 'resumed', child: resumed.child, session: resumed.session, link: resumed.link, corrected, ...(resumed.reportWarning ? { reportWarning: resumed.reportWarning } : {}) };
  });
}
