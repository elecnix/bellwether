// One machine, as a move sees it. The operations are the same on every
// machine; only the way to reach them differs. This machine runs them in the
// daemon's own process, and another machine runs them through `bellwether
// move-*` over SSH, with the request on standard input and one JSON line back,
// so a move from here to there and a move from there to here run one code path.
import { LOCAL_HOST, resolveMachine, type MachineResolver } from './machine.ts';
import { commitImport, discardImport, exportSession, importSession, probeMachine, type ExportRequest, type ImportRequest, type ImportResult, type ProbeRequest, type ProbeResult, type SessionBundle, type SettleRequest } from './session-state.ts';
import { describeFailure, releaseAdvice, runRemoteBellwether, type SshOptions } from './ssh.ts';

export interface MoveEndpoint {
  /** The host as child records name it: `local`, or a saved herdr machine. */
  host: string;
  probe(request: ProbeRequest): Promise<ProbeResult>;
  exportSession(request: ExportRequest): Promise<SessionBundle>;
  importSession(request: ImportRequest): Promise<ImportResult>;
  discard(request: SettleRequest): Promise<void>;
  commit(request: SettleRequest): Promise<void>;
}

/** This machine, served in the daemon's process. */
export function localEndpoint(): MoveEndpoint {
  return {
    host: LOCAL_HOST,
    probe: (request) => probeMachine(request),
    exportSession: async (request) => exportSession(request),
    importSession: async (request) => importSession(request),
    discard: async (request) => {
      discardImport(request);
    },
    commit: async (request) => {
      commitImport(request);
    },
  };
}

/** The verbs `bellwether` takes on the machine side of a move. */
export const MOVE_VERBS = ['move-probe', 'move-export', 'move-import', 'move-discard', 'move-commit'] as const;
export type MoveVerb = (typeof MOVE_VERBS)[number];

/** Run one move verb on this machine, for the CLI that SSH starts. */
export async function serveMoveVerb(verb: MoveVerb, request: unknown): Promise<unknown> {
  const body = (request ?? {}) as never;
  switch (verb) {
    case 'move-probe':
      return probeMachine(body as ProbeRequest);
    case 'move-export':
      return exportSession(body as ExportRequest);
    case 'move-import':
      return importSession(body as ImportRequest);
    case 'move-discard':
      return discardImport(body as SettleRequest);
    case 'move-commit':
      return commitImport(body as SettleRequest);
  }
}

/** Session bundles carry whole transcripts, so a reply may be far larger than a report. */
const MOVE_MAX_BUFFER = 512 * 1024 * 1024;

/** Another machine, reached through its saved herdr profile's SSH target. */
export function remoteEndpoint(host: string, resolve: MachineResolver = resolveMachine, options: SshOptions = {}): MoveEndpoint {
  // A bellwether that predates moves reads an unknown verb as a session
  // command, which creates a registry and starts a daemon there. Its help has
  // no such effect, and lists the verbs it knows, so it is asked first.
  let capable: Promise<void> | undefined;
  const ensureCapable = (target: string): Promise<void> => {
    capable ??= runRemoteBellwether(target, ['help'], options).then((result) => {
      if (result.code !== 0 && !result.stdout.includes('Usage: bellwether')) throw new Error(describeFailure(target, result));
      if (!result.stdout.includes('move-probe')) throw new Error(`bellwether on machine ${host} predates agent_move. ${releaseAdvice(target, { ...result, command: ['move-probe'] }) ?? ''}`.trimEnd());
    });
    capable.catch(() => {
      capable = undefined;
    });
    return capable;
  };
  const call = async <T>(verb: MoveVerb, request: unknown, timeoutMs = 120_000): Promise<T> => {
    const profile = await resolve(host);
    await ensureCapable(profile.target);
    const result = await runRemoteBellwether(profile.target, [verb], { ...options, input: JSON.stringify(request), timeoutMs: options.timeoutMs ?? timeoutMs, maxBuffer: MOVE_MAX_BUFFER });
    const line = result.stdout.trim().split('\n').filter(Boolean).pop() ?? '';
    let reply: { ok?: boolean; result?: T; error?: string } | undefined;
    try {
      reply = JSON.parse(line) as { ok?: boolean; result?: T; error?: string };
    } catch {
      reply = undefined;
    }
    if (reply?.ok) return reply.result as T;
    if (reply?.error) throw new Error(`bellwether ${verb} on machine ${host}: ${reply.error}`);
    throw new Error(result.code === 0 ? `bellwether ${verb} on machine ${host} printed no reply: ${line || '(nothing)'}` : describeFailure(profile.target, result));
  };
  return {
    host,
    probe: (request) => call<ProbeResult>('move-probe', request),
    exportSession: (request) => call<SessionBundle>('move-export', request),
    importSession: (request) => call<ImportResult>('move-import', request),
    discard: async (request) => {
      await call('move-discard', request);
    },
    commit: async (request) => {
      await call('move-commit', request);
    },
  };
}

/** The endpoint for a host. */
export type EndpointFor = (host: string) => MoveEndpoint;

export function moveEndpoints(resolve: MachineResolver = resolveMachine, options: SshOptions = {}): EndpointFor {
  return (host) => (host === LOCAL_HOST ? localEndpoint() : remoteEndpoint(host, resolve, options));
}
