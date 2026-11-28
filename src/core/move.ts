// Moving a live child to another machine, in either direction, under the same
// child id. The steps are carry.ts's, which agent_teleport shares. A move's
// own policy refuses a stopped child, tells the child nothing, and logs to
// move.log.
import path from 'node:path';
import { carryChild, where, type CarryDeps, type CarryPolicy, type CarryRequest } from './carry.ts';
import { LOCAL_HOST } from './machine.ts';
import { moveRefusals, type MoveStage } from './move-plan.ts';
import { bellwetherHome } from './paths.ts';
import type { ChildRecord } from './types.ts';

export { MOVE_WINDOW_MS, verifyCopy } from './carry.ts';

export function moveLogPath(): string {
  return path.join(bellwetherHome(), 'move.log');
}

export type MoveRequest = CarryRequest;

export type MoveDeps = Omit<CarryDeps, 'inbox' | 'by'>;

export interface MoveResult {
  child: ChildRecord;
  from: string;
  to: string;
  /** The session file the child resumed on the target. */
  sessionFile: string;
  /** The bytes that crossed, every file of the session together. */
  bytes: number;
  link: string;
  /** What stayed on the source because the caller accepted the loss, one line each. */
  leftBehind: string[];
}

/** A move that never started, with every reason. Nothing was touched. */
export class MoveRefusedError extends Error {
  readonly reasons: string[];

  constructor(childName: string, target: string, reasons: string[]) {
    super(`Bellwether refused to move ${childName} to ${where(target)}:\n${reasons.map((reason) => `- ${reason}`).join('\n')}`);
    this.name = 'MoveRefusedError';
    this.reasons = reasons;
  }
}

/** A move that started and was undone. The message says where the child runs now. */
export class MoveFailedError extends Error {
  readonly stage: MoveStage;
  readonly restoredPane?: string;

  constructor(message: string, stage: MoveStage, restoredPane?: string) {
    super(message);
    this.name = 'MoveFailedError';
    this.stage = stage;
    this.restoredPane = restoredPane;
  }
}

const MOVE: CarryPolicy = {
  verb: 'move',
  refuse: (facts) => {
    const reasons = moveRefusals({ ...facts, exited: facts.state === 'stopped' });
    // A route is this machine's launcher, which the other machine's routes file does not hold.
    if (facts.route && facts.target !== LOCAL_HOST) reasons.push(`${facts.childName} runs on route ${facts.route}, a launcher this machine's routes file defines, so it cannot resume behind it on ${where(facts.target)}. Restart it with agent_restart and via none first, then move it.`);
    return reasons;
  },
  refused: (name, target, reasons) => new MoveRefusedError(name, target, reasons),
  failed: (message, stage, restoredPane) => new MoveFailedError(message, stage, restoredPane),
  logPath: moveLogPath,
  outcome: () => 'moved',
};

export async function moveChild(deps: MoveDeps, parentId: string, request: MoveRequest): Promise<MoveResult> {
  const result = await carryChild(deps, parentId, request, MOVE);
  return { child: result.child, from: result.from.host, to: result.to.host, sessionFile: result.sessionFile, bytes: result.bytes, link: result.link, leftBehind: result.leftBehind };
}
