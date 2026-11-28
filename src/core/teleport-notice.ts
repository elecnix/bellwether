// What a teleported agent is told before its first turn (issue #226). The
// notice is the first input its resumed session reads, so it says, in the
// words a person would use, which machine and directory the agent left, which
// it is in now, who sent it and why, and what did not come with it.
import os from 'node:os';
import { LOCAL_HOST } from './machine.ts';
import type { TeleportState } from './teleport-plan.ts';

export interface NoticePlace {
  /** The machine's name as a person knows it. */
  machine: string;
  cwd: string;
}

export interface NoticeInput {
  from: NoticePlace;
  to: NoticePlace;
  /** When the teleport was asked for. */
  at: string;
  /** Who asked for it: the agent's parent, or the agent itself. */
  requester: 'parent' | 'self';
  reason?: string;
  state: TeleportState;
}

/** A host as the notice names it: a saved herdr machine by its label, and this machine by its hostname, since the agent will not be on this machine when it reads it. */
export function machineLabel(host: string): string {
  return host === LOCAL_HOST ? os.hostname() : host;
}

export function teleportNotice(input: NoticeInput): string {
  const before = input.state === 'stopped' ? 'You were stopped, and you' : 'You';
  const why = input.reason ? `, because ${input.reason.replace(/\.$/, '')}` : '';
  return [
    `${before} were teleported from machine ${input.from.machine}, directory ${input.from.cwd}, to machine ${input.to.machine}, directory ${input.to.cwd}, at ${input.at}, at ${input.requester === 'self' ? 'your own' : "your parent's"} request${why}.`,
    '',
    `Your conversation crossed. Your worktree, the shell jobs you ran and any file outside the session did not cross: ${input.requester === 'self' ? `you prepared ${input.to.cwd} yourself before you asked` : `your parent prepared ${input.to.cwd} for you`}. A background command you started before the teleport will not report back. Check the state of ${input.to.cwd} before you rely on anything you did there.`,
  ].join('\n');
}
