// Routes: a launcher wrapper that runs a harness and routes it. A route is
// this machine's configuration, not the child's, so it lives in the operator's
// own config directory: `~/.config/bellwether/routes.json`, or the file that
// BELLWETHER_ROUTES names. The Bellwether home holds state the daemon writes
// and prunes; a route is a setting a person writes once per machine, beside
// the launcher it describes, and it must outlive a wiped home.
//
// A route declares the launcher's argv prefix, where the tier goes, which
// tiers it accepts and the default one, and how a key file reaches the
// launcher. A child started on a route runs
//
//   [key env from file] <launcher...> <tier args...> <harness> <harness args...>
//
// The decisions here are pure functions of the config and the request, so a
// test asserts the arguments, not a string that could match anything.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildRoute } from './types.ts';

/** How a key file reaches a route's launcher. The file's path travels, never its contents. */
export type RouteKey =
  /** The pane's shell reads the file into this environment variable when the line runs. */
  | { env: string }
  /** The launcher takes the file's path with this flag, and reads the file itself. */
  | { flag: string };

export interface RouteConfig {
  /** The launcher's argv prefix, which runs in front of the harness. */
  launcher: string[];
  /**
   * The arguments that carry the tier, after the launcher prefix and before the
   * harness name. Each `{tier}` becomes the tier. Defaults to `--model {tier}`.
   */
  tierArgs?: string[];
  /** The tier names the launcher accepts. With none listed, any model is passed through as the tier. */
  tiers?: string[];
  /** The tier a child starts on when the caller names none. */
  defaultTier?: string;
  /** How a key file reaches the launcher. A route without one refuses key_file. */
  key?: RouteKey;
  /** The harness kinds the launcher runs. Defaults to claude, pi and codex. */
  harnesses?: string[];
  /**
   * Arguments a harness needs on this route, by kind, placed right after the
   * harness name. A shell function that adds flags to a bare start does not
   * run behind a launcher, so the route carries those flags itself.
   */
  harnessArgs?: Record<string, string[]>;
  /** One line: what a child on this route sees that a bare one does not. doctor prints it. */
  description?: string;
}

export interface RoutesFile {
  /** Where the routes came from, for messages. */
  file: string;
  /** Set when the file does not exist, so a message can say to create it rather than to edit it. */
  missing?: boolean;
  routes: Record<string, RouteConfig>;
}

/** The value of via that starts the harness bare. */
export const BARE = 'none';

const DEFAULT_TIER_ARGS = ['--model', '{tier}'];
const DEFAULT_HARNESSES = ['claude', 'pi', 'codex'];
const NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The routes file on this machine. */
export function routesPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['BELLWETHER_ROUTES'];
  if (override) return override;
  const config = env['XDG_CONFIG_HOME'] || path.join(os.homedir(), '.config');
  return path.join(config, 'bellwether', 'routes.json');
}

/** A routes file that is there but cannot be used, named by its path. */
export class RoutesFileError extends Error {
  constructor(file: string, reason: string) {
    super(`The routes file ${file} cannot be used: ${reason}`);
    this.name = 'RoutesFileError';
  }
}

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.length > 0);
}

/** Check one route's shape, and say what is wrong with it. */
function checkRoute(file: string, name: string, value: unknown): RouteConfig {
  const fail = (reason: string): never => {
    throw new RoutesFileError(file, `route ${name} ${reason}`);
  };
  if (!NAME.test(name)) fail('has a name that is not lower-case letters, digits, - and _');
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('is not an object');
  const route = value as Record<string, unknown>;
  if (!stringList(route['launcher']) || route['launcher'].length === 0) fail('needs launcher, the argv prefix that runs in front of the harness, as a list of strings');
  if (route['tierArgs'] !== undefined && (!stringList(route['tierArgs']) || !route['tierArgs'].some((arg) => arg.includes('{tier}')))) fail('has tierArgs without {tier} in them');
  if (route['tiers'] !== undefined && !stringList(route['tiers'])) fail('has tiers that are not a list of strings');
  if (route['defaultTier'] !== undefined && typeof route['defaultTier'] !== 'string') fail('has a defaultTier that is not a string');
  const tiers = route['tiers'] as string[] | undefined;
  if (typeof route['defaultTier'] === 'string' && tiers && !tiers.includes(route['defaultTier'])) fail(`has defaultTier ${route['defaultTier']}, which is not one of its tiers`);
  if (route['harnesses'] !== undefined && !stringList(route['harnesses'])) fail('has harnesses that are not a list of strings');
  if (route['description'] !== undefined && typeof route['description'] !== 'string') fail('has a description that is not a string');
  const extra = route['harnessArgs'];
  if (extra !== undefined && (typeof extra !== 'object' || extra === null || Array.isArray(extra) || !Object.values(extra).every((value) => Array.isArray(value) && value.every((arg) => typeof arg === 'string')))) fail('has harnessArgs that are not lists of strings by harness kind');
  const key = route['key'];
  if (key !== undefined) {
    const entry = typeof key === 'object' && key !== null ? (key as Record<string, unknown>) : {};
    const env = entry['env'];
    const flag = entry['flag'];
    if ((env === undefined) === (flag === undefined)) fail('needs key to name exactly one of env or flag');
    if (env !== undefined && (typeof env !== 'string' || !ENV_NAME.test(env))) fail('has a key env that is not an environment variable name');
    if (flag !== undefined && (typeof flag !== 'string' || !flag.startsWith('-'))) fail('has a key flag that does not start with -');
  }
  return route as unknown as RouteConfig;
}

/** Read the routes file. A missing file defines no routes; a broken one is an error that names it. */
export function readRoutes(file: string = routesPath()): RoutesFile {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { file, missing: true, routes: {} };
    throw new RoutesFileError(file, (error as Error).message);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new RoutesFileError(file, `it is not JSON (${(error as Error).message})`);
  }
  const routes = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>)['routes'] : undefined;
  if (typeof routes !== 'object' || routes === null || Array.isArray(routes)) throw new RoutesFileError(file, 'it needs a "routes" object, keyed by route name');
  const checked: Record<string, RouteConfig> = {};
  for (const [name, value] of Object.entries(routes)) {
    if (name === BARE) throw new RoutesFileError(file, `"${BARE}" is reserved for a bare start`);
    checked[name] = checkRoute(file, name, value);
  }
  return { file, routes: checked };
}

/** What a spawn, resume or restart asked for. */
export interface RouteRequest {
  /** The child's name, for messages. */
  name: string;
  kind: string;
  /** A route name, `none` for bare, or undefined for the default. */
  via?: string;
  /** The model, which on a route names a tier. */
  model?: string;
  /** A file that holds the key the route's launcher runs under. */
  keyFile?: string;
  /** The host the child starts on. A route is this machine's. */
  host?: string;
  /** What the refusal says did not happen: started, by default, or resumed or restarted. */
  verb?: string;
}

/** The launch a request resolves to. */
export interface ResolvedRoute {
  /** The route to record, or undefined for a bare start. */
  route?: ChildRoute;
  /** The model for the harness itself: the caller's on a bare start, none on a route. */
  harnessModel?: string;
}

function routeNames(routes: RoutesFile): string {
  const names = Object.keys(routes.routes);
  return names.length ? `Routes defined there: ${names.join(', ')}.` : 'That file defines no routes.';
}

/** Why a route name resolves to nothing: no routes file, a file with no routes, or a file without that one. */
function unknownRoute(via: string, routes: RoutesFile): string {
  if (routes.missing) return `via ${via} names a route, and the routes file ${routes.file} does not exist. Create it with a route named ${via} (docs/routes.md gives the fields), or pass via ${BARE} for a bare start.`;
  const names = Object.keys(routes.routes);
  if (!names.length) return `via ${via} names a route, and the routes file ${routes.file} defines none. Add a route named ${via} there, or pass via ${BARE} for a bare start.`;
  return `via ${via} names no route in ${routes.file}. Routes defined there: ${names.join(', ')}. Pass one of them, add ${via} to that file, or pass via ${BARE} for a bare start.`;
}

/** The route whose tiers name this model, if any. */
function routeOfTier(routes: RoutesFile, model: string): string | undefined {
  return Object.entries(routes.routes).find(([, route]) => route.tiers?.includes(model))?.[0];
}

/**
 * Decide how a child starts, or refuse with the flag to add or drop. Every
 * refusal happens before a record or a tab exists.
 */
export function resolveRoute(request: RouteRequest, routes: RoutesFile): ResolvedRoute {
  const { name, kind, model, keyFile } = request;
  const via = request.via?.trim() || undefined;
  const lead = `${name} was not ${request.verb ?? 'started'}:`;
  if (!via || via === BARE) {
    if (keyFile) throw new Error(`${lead} key_file needs via, a route whose launcher takes a key; a bare start has no launcher to give it to. Add via with a route, or drop key_file.`);
    const tierOf = model ? routeOfTier(routes, model) : undefined;
    if (model && tierOf) {
      throw new Error(via === BARE
        ? `${lead} model ${model} is a tier of route ${tierOf}, and via ${BARE} starts ${kind} bare, which does not know that tier. Pass via ${tierOf}, or drop via ${BARE}.`
        : `${lead} model ${model} is a tier of route ${tierOf}, not a model ${kind} knows. Add via ${tierOf}.`);
    }
    return model ? { harnessModel: model } : {};
  }
  const route = routes.routes[via];
  if (!route) throw new Error(`${lead} ${unknownRoute(via, routes)}`);
  if ((request.host ?? 'local') !== 'local') throw new Error(`${lead} route ${via} describes this machine's launcher, and ${name} would run on machine ${request.host}. Drop via, or define the route on that machine and start the child from there.`);
  const harnesses = route.harnesses ?? DEFAULT_HARNESSES;
  if (!harnesses.includes(kind)) throw new Error(`${lead} route ${via} runs ${harnesses.join(', ')}, not ${kind}. Drop via, or pass a kind the route runs.`);
  if (model && route.tiers && !route.tiers.includes(model)) {
    const fallback = route.defaultTier ? ` Drop model to run on its default tier ${route.defaultTier},` : ' Drop model,';
    throw new Error(`${lead} model ${model} is not a tier of route ${via}, which takes ${route.tiers.join(', ')}.${fallback} or drop via to run ${model} bare.`);
  }
  if (keyFile) {
    if (!route.key) throw new Error(`${lead} route ${via} declares no key, so it cannot take key_file. Drop key_file, or add key to the route in ${routes.file}.`);
    checkKeyFile(name, keyFile, request.verb);
  }
  const tier = model ?? route.defaultTier;
  return { route: { name: via, ...(tier ? { tier } : {}), ...(keyFile ? { keyFile: path.resolve(expandHome(keyFile)) } : {}) } };
}

function expandHome(file: string): string {
  return file === '~' || file.startsWith('~/') ? path.join(os.homedir(), file.slice(1)) : file;
}

/** Refuse a key file that is missing or empty. Its contents are never read into Bellwether. */
export function checkKeyFile(name: string, keyFile: string, verb = 'started'): void {
  const file = path.resolve(expandHome(keyFile));
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new Error(`${name} was not ${verb}: key_file ${file} does not exist. Pass the path of a file that holds the key, or drop key_file.`);
  }
  if (!stat.isFile()) throw new Error(`${name} was not ${verb}: key_file ${file} is not a file. Pass the path of a file that holds the key, or drop key_file.`);
  if (stat.size === 0) throw new Error(`${name} was not ${verb}: key_file ${file} is empty. Put the key in it, or drop key_file.`);
}

/** The command a routed child runs: an environment the pane's shell fills, then argv. */
export interface RouteLaunch {
  /** Variables the pane's shell sets from a file when the line runs, by name. */
  envFromFile: Record<string, string>;
  argv: string[];
}

/**
 * The launch for a child on a route: the launcher prefix, the tier, then the
 * harness and its own arguments, which the launcher hands on unchanged.
 */
export function routeLaunch(config: RouteConfig, route: ChildRoute, kind: string, harnessArgs: string[]): RouteLaunch {
  const tierArgs = route.tier ? (config.tierArgs ?? DEFAULT_TIER_ARGS).map((arg) => arg.replaceAll('{tier}', route.tier as string)) : [];
  const envFromFile: Record<string, string> = {};
  const keyArgs: string[] = [];
  if (route.keyFile && config.key) {
    if ('env' in config.key) envFromFile[config.key.env] = route.keyFile;
    else keyArgs.push(config.key.flag, route.keyFile);
  }
  return { envFromFile, argv: [...config.launcher, ...keyArgs, ...tierArgs, kind, ...(config.harnessArgs?.[kind] ?? []), ...harnessArgs] };
}

/**
 * The launch for a bare child: the harness's own executable, behind the
 * shell's `command` builtin. The pane's shell resolves the name on its PATH
 * and skips a function or alias of the same name, which an operator's startup
 * files may define to add flags of their own, so the child gets exactly the
 * arguments Bellwether chose.
 */
export function bareLaunch(kind: string, harnessArgs: string[]): RouteLaunch {
  return { envFromFile: {}, argv: ['command', kind, ...harnessArgs] };
}

/** Quote one word for a POSIX shell. */
export function shellQuote(word: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) return word;
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * The line typed into the pane's shell. A key reaches the launcher as
 * `NAME="$(cat 'file')"`, which the shell expands when the line runs, so the
 * value never appears on a command line, in a herdr request or in a log.
 */
export function launchLine(launch: RouteLaunch): string {
  const env = Object.entries(launch.envFromFile).map(([name, file]) => `${name}="$(cat ${shellQuote(file)})"`);
  return [...env, ...launch.argv.map(shellQuote)].join(' ');
}

/** The route a record carries, in the short form agent_list shows. */
export function routeLabel(route: ChildRoute | undefined): string {
  if (!route) return 'bare';
  return `${route.name}${route.tier ? `:${route.tier}` : ''}${route.keyFile ? ' (key file)' : ''}`;
}

/** Find a route's config, or say the file no longer defines it. */
export function routeConfig(routes: RoutesFile, route: ChildRoute, name: string): RouteConfig {
  const config = routes.routes[route.name];
  if (!config) throw new Error(`${name} started on route ${route.name}, which ${routes.file} no longer defines. ${routeNames(routes)} Pass via with one of them, or via ${BARE}.`);
  return config;
}

/** What a child on a route sees that a bare one does not, read from the route's own config. */
export function routeExplanation(name: string, config: RouteConfig | undefined): string {
  if (!config) return `route ${name} is not defined in this machine's routes file, so a child recorded on it cannot be restarted on it.`;
  const tiers = config.tiers?.length ? `, on tier ${config.defaultTier ?? config.tiers[0]} unless the spawn names one of ${config.tiers.join(', ')}` : '';
  const key = config.key ? ('env' in config.key ? `, and a key file reaches it as ${config.key.env}` : `, and a key file reaches it with ${config.key.flag}`) : '';
  const own = config.description ? ` ${config.description}` : '';
  return `a child on route ${name} runs under \`${config.launcher.join(' ')}\`${tiers}${key}, where a bare child runs the harness directly.${own}`;
}

/**
 * The doctor lines for this machine's routes: where the file is, then one line
 * per route that is defined or that a live child runs on, each read from the
 * route's own config.
 */
export function describeRoutes(read: () => RoutesFile, children: { name: string; route?: ChildRoute }[]): string[] {
  let routes: RoutesFile;
  try {
    routes = read();
  } catch (error) {
    return [`fail  routes: ${(error as Error).message}`];
  }
  const names = Object.keys(routes.routes);
  const used = new Map<string, string[]>();
  for (const child of children) {
    if (!child.route) continue;
    used.set(child.route.name, [...(used.get(child.route.name) ?? []), child.name]);
  }
  const lines = [names.length ? `ok    routes: ${routes.file} defines ${names.join(', ')}` : routes.missing ? `info  routes: ${routes.file} does not exist, so every child starts bare` : `info  routes: ${routes.file} defines none, so every child starts bare`];
  for (const name of new Set([...names, ...used.keys()])) {
    const on = used.get(name);
    const who = on ? ` (${on.join(', ')})` : '';
    lines.push(`${routes.routes[name] ? 'info' : 'fail'}  route ${name}${who}: ${routeExplanation(name, routes.routes[name])}`);
  }
  return lines;
}
