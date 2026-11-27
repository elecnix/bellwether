// A Claude Code child's own settings file, passed with --settings. Claude Code
// merges it over every other settings source, so the child keeps the
// operator's own settings and gains only what this file adds. The operator's
// settings files are never written.
//
// This module is the one writer of the file. Each part a child needs is one
// field of `ClaudeSettingsParts`, and `claudeChildSettings` composes them, so
// a new part adds a field here rather than a second function that writes the
// same path.
import fs from 'node:fs';
import { claudeSettingsDir, claudeSettingsPath } from './paths.ts';

export interface ClaudeSettingsParts {
  /** Plugins to turn off for this child, by `name@marketplace`: a Bellwether plugin that would duplicate the child's own server. */
  disablePlugins?: readonly string[];
}

/** The settings one child starts with, or undefined when it needs none. */
export function claudeChildSettings(parts: ClaudeSettingsParts): Record<string, unknown> | undefined {
  const settings: Record<string, unknown> = {};
  if (parts.disablePlugins?.length) settings['enabledPlugins'] = Object.fromEntries(parts.disablePlugins.map((id) => [id, false]));
  return Object.keys(settings).length ? settings : undefined;
}

/**
 * Write the child's settings with mode 0600 in a 0700 directory, and return
 * the path. A child that needs no settings gets no file, and any file an
 * earlier start left for it goes.
 */
export function writeClaudeSettings(childId: string, parts: ClaudeSettingsParts): string | undefined {
  const settings = claudeChildSettings(parts);
  if (!settings) {
    removeClaudeSettings(childId);
    return undefined;
  }
  const dir = claudeSettingsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const file = claudeSettingsPath(childId);
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

/** Remove a child's settings. A file that is already gone is not an error. */
export function removeClaudeSettings(childId: string): void {
  fs.rmSync(claudeSettingsPath(childId), { force: true });
}
