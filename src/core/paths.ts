import os from 'node:os';
import path from 'node:path';

/** Every Bellwether file lives under one directory, overridable for tests. */
export function bellwetherHome(): string {
  return process.env['BELLWETHER_HOME'] ?? path.join(os.homedir(), '.bellwether');
}

export function parentsDir(): string {
  return path.join(bellwetherHome(), 'parents');
}

export function outboxDir(): string {
  return path.join(bellwetherHome(), 'outbox');
}

export function spoolDir(): string {
  return path.join(bellwetherHome(), 'spool');
}

/** One registry file per parent session, so a resumed parent reads the same file. */
export function parentId(harness: string, session: string): string {
  return `${harness}-${slug(session)}`;
}

export function registryPath(id: string): string {
  return path.join(parentsDir(), `${slug(id)}.json`);
}

export function outboxPath(id: string): string {
  return path.join(outboxDir(), `${slug(id)}.json`);
}

export function spoolPath(id: string): string {
  return path.join(spoolDir(), `${slug(id)}.jsonl`);
}

/** A herdr-safe handle: no separators, no spaces, nothing that needs quoting. */
export function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'unnamed';
}
