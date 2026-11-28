// The decisions a teleport makes, as pure functions of what it found, so each
// refusal can be tested on its own (issue #226). A teleport carries a session
// the way agent_move does, so it keeps every refusal move-plan.ts names but
// one: a stopped agent crosses too. It adds three of its own, each a
// different repair: a destination directory Bellwether will not create, a
// destination with no inbound path for the notice, and an adopted child.
import type { ChildRecord } from './types.ts';
import { LOCAL_HOST } from './machine.ts';
import { moveRefusals, type RefusalInput } from './move-plan.ts';

/** Whether the agent ran when the teleport began. A stopped one has no tab to close. */
export type TeleportState = 'live' | 'stopped';

/** One place an agent ran, on the teleport's record. */
export interface TeleportPlace {
  host: string;
  cwd: string;
  /** The pane it ran in there. A stopped agent's pane at the source may be gone. */
  paneId?: string;
}

/** How the notice reached the teleported session. */
export interface TeleportNoticeRecord {
  /** The message that carried it. */
  message?: string;
  /** The adapter that received it. */
  via?: string;
  receivedAt?: string;
  readAt?: string;
  /** When the model read it and began a turn on it. */
  takenAt?: string;
  /** Why Bellwether did not see the model take it. The message stays on the record for the session's next hello. */
  undelivered?: string;
}

/**
 * One teleport on a child record (issue #226). `alive.proof` is `took-notice`
 * when the model read the notice and began a turn on it, and `detected` when
 * herdr only saw the harness start on the session, the weaker proof.
 */
export interface TeleportEntry {
  at: string;
  by: string;
  reason?: string;
  state: TeleportState;
  from: TeleportPlace;
  to: TeleportPlace;
  sessionFile: string;
  bytes: number;
  notice: TeleportNoticeRecord;
  alive: { at: string; proof: 'took-notice' | 'detected' };
}

/** The issue whose fix lets an adopted child teleport: until a parent's record and the far daemon agree on it, a teleport would carry the disagreement along. */
export const ADOPTED_TELEPORT_ISSUE = 'https://github.com/elecnix/bellwether/issues/219';

export interface TeleportRefusalInput extends Omit<RefusalInput, 'exited'> {
  state: TeleportState;
  /** How the child came to this parent. */
  origin?: ChildRecord['origin'];
  /** The route the child runs on, which only this machine's routes file defines. */
  route?: string;
  /** Why the destination has no way to put the notice into the agent's session, when it has none. */
  inbound?: string;
}

/** A child is stopped when its record says it exited, or names no pane to close. */
export function teleportState(child: Pick<ChildRecord, 'paneId' | 'exitedAt'>): TeleportState {
  return child.exitedAt || !child.paneId ? 'stopped' : 'live';
}

function machineName(host: string): string {
  return host === LOCAL_HOST ? 'this machine' : `machine ${host}`;
}

/**
 * Every reason the teleport must not start, each naming what failed and what
 * a person does about it. An empty list means it may begin.
 */
export function teleportRefusals(input: TeleportRefusalInput): string[] {
  const where = machineName(input.target);
  // A stopped agent has no turn to cut, whatever its last status said, so move's
  // rule about a running child does not apply to it. That is the one rule a
  // teleport loosens, and the reply says so.
  const live = input.state === 'live';
  const { state: _state, origin: _origin, route: _route, inbound: _inbound, targetCwdExists, ...move } = input;
  const reasons = moveRefusals({ ...move, exited: false, status: live ? input.status : 'idle' });
  // The harness check returns alone: nothing else can be judged about a harness Bellwether cannot carry.
  if (reasons.length === 1 && /Bellwether moves only/.test(reasons[0] ?? '')) return reasons;
  if (input.origin === 'adopt') {
    reasons.push(`${input.childName} is an adopted child. Bellwether did not start it, and its parent's record and the daemon that holds its pane can disagree about it, so a teleport would carry that disagreement to ${where}. Teleporting an adopted child waits on ${ADOPTED_TELEPORT_ISSUE}.`);
  }
  if (input.route && input.target !== LOCAL_HOST) {
    reasons.push(`${input.childName} runs on route ${input.route}, a launcher this machine's routes file defines, so it cannot resume behind it on ${where}. Restart it with agent_restart and via none first, then teleport it.`);
  }
  if (input.targetCwd && targetCwdExists === false) {
    reasons.push(`The working directory ${input.targetCwd} does not exist on ${where}, and Bellwether does not create it. Whoever asks for the teleport prepares the destination first: the folder, the worktree and anything the agent needs there. Then teleport it, or pass cwd with a directory that exists.`);
  }
  if (input.inbound) {
    reasons.push(`There is no inbound path into ${input.childName}'s ${input.harness} session on ${where}: ${input.inbound.replace(/\.$/, '')}. A teleported agent must be told it was teleported before its first turn, and Bellwether never types that notice into a pane, so it does not teleport an agent it cannot tell.`);
  }
  return reasons;
}
