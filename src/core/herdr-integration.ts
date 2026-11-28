// herdr's integrations, as its `integration.list` API reports them. herdr
// learns some harnesses' sessions only through an integration of its own: a pi
// extension, a Claude Code hook. A machine whose herdr lacks one shows that
// harness's panes with no session, so Bellwether never records one, and a
// move, a restart or a resume by session has nothing to reopen. The state is
// read from herdr on the child's machine, through the same client that starts
// the child there, so this machine and another one answer the same way.
import { LOCAL_HOST } from './machine.ts';
import type { HarnessEntry, HerdrRequester } from './harnesses/types.ts';

/** The states herdr reports for an integration that is in place. An outdated one still reports sessions. */
const WORKING = new Set(['current', 'outdated']);

/** Each integration herdr lists, by target, with the state herdr gives it. Throws when herdr does not answer. */
export async function listIntegrations(herdr: HerdrRequester): Promise<Map<string, string>> {
  const result = await herdr.request('integration.list', {});
  const list = typeof result === 'object' && result !== null ? (result as Record<string, unknown>)['integrations'] : undefined;
  const states = new Map<string, string>();
  if (!Array.isArray(list)) return states;
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { target, state } = entry as Record<string, unknown>;
    if (typeof target === 'string') states.set(target, typeof state === 'string' ? state : 'unknown');
  }
  return states;
}

/** Whether herdr's list holds the integration in a state that reports sessions. A target missing from the list is not installed. */
export function integrationWorks(states: Map<string, string>, target: string): boolean {
  return WORKING.has(states.get(target) ?? 'not_installed');
}

/**
 * The herdr integration a child of this kind needs for herdr to report its
 * session, when herdr on the child's machine says it is missing. Undefined
 * when it is there, when the harness needs none, and when herdr cannot say,
 * because Bellwether names a cause only when herdr confirms it.
 */
export async function missingIntegration(herdr: HerdrRequester | undefined, entry: Pick<HarnessEntry, 'session'> | undefined): Promise<string | undefined> {
  const target = integrationOf(entry);
  if (!target || !herdr) return undefined;
  try {
    return integrationWorks(await listIntegrations(herdr), target) ? undefined : target;
  } catch {
    return undefined;
  }
}

/** The integration a harness needs herdr to have for its sessions, or undefined for a harness that keeps them elsewhere. */
export function integrationOf(entry: Pick<HarnessEntry, 'session'> | undefined): string | undefined {
  const source = entry?.session;
  return source?.from === 'herdr' ? source.integration : undefined;
}

/**
 * How doctor words the integrations a machine's herdr has, one per target:
 * present, missing with the command that installs it, or a state Bellwether
 * does not know in herdr's own word. When herdr did not answer, all of them
 * are unknown, because doctor reports only what herdr confirms.
 */
export function describeIntegrations(states: Map<string, string> | Error, targets: string[], host: string | undefined): string {
  if (states instanceof Error) return `herdr integrations unknown (${states.message})`;
  return targets
    .map((target) => {
      const state = states.get(target) ?? 'not_installed';
      if (WORKING.has(state)) return `herdr ${target} integration present${state === 'current' ? '' : ` (${state})`}`;
      if (state === 'not_installed') return `herdr ${target} integration missing (run \`herdr integration install ${target}\` on ${machineWords(host)})`;
      return `herdr ${target} integration ${state}, as herdr reports it`;
    })
    .join(', ');
}

function machineWords(host: string | undefined): string {
  return (host ?? LOCAL_HOST) === LOCAL_HOST ? 'this machine' : `machine ${host}`;
}

/** Why a child has no recorded session, and what fixes it, when herdr on its machine lacks the integration. */
export function noSessionCause(integration: string, host: string | undefined, name: string): string {
  return `herdr on ${machineWords(host)} has no ${integration} integration, so it never reported ${name}'s session. Run \`herdr integration install ${integration}\` on ${machineWords(host)}, then spawn the child again, and herdr reports its session from the start.`;
}

/** The spawn reply's warning for a child whose machine's herdr lacks the integration that reports its session. */
export function noSessionWarning(integration: string, host: string | undefined, name: string): string {
  return `Warning: herdr on ${machineWords(host)} has no ${integration} integration, so it will not report ${name}'s session, and Bellwether cannot move ${name}, restart it or resume it by its session. Run \`herdr integration install ${integration}\` on ${machineWords(host)}, then spawn the child again to fix that.`;
}

/** A refusal that says a child has no recorded session, with the cause appended when herdr on its machine confirms one. */
export async function withSessionCause(refusal: string, herdr: HerdrRequester | undefined, entry: Pick<HarnessEntry, 'session'> | undefined, child: { name: string; host?: string }): Promise<string> {
  const integration = await missingIntegration(herdr, entry);
  return integration ? `${refusal} ${noSessionCause(integration, child.host, child.name)}` : refusal;
}
