/**
 * Config loader (Wave 2c).
 *
 * Reads an optional JSON config file, then runs it through the LOCKED
 * `parseConfig` (deep-merge with `defaultConfig` + validate). When no source
 * is given and `./agent.config.json` does not exist, returns the conservative
 * `defaultConfig` (dry-run + mock connectors).
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import type { AgentConfig } from '../contracts/index.js';
import { defaultConfig, parseConfig, validateConfig } from '../contracts/index.js';

/** Default config file looked up in the working directory when no source given. */
const DEFAULT_CONFIG_PATH = './agent.config.json';

/**
 * Load + validate config from a JSON file path. Falls back to
 * `./agent.config.json` when present, otherwise the locked `defaultConfig`.
 */
export async function loadConfig(source?: string): Promise<AgentConfig> {
  const path =
    source ?? (existsSync(DEFAULT_CONFIG_PATH) ? DEFAULT_CONFIG_PATH : undefined);

  if (path === undefined) {
    return defaultConfig;
  }

  const raw = await readFile(path, 'utf8');
  const json: unknown = JSON.parse(raw);
  // parseConfig already deep-merges with defaults + validates; the extra
  // validateConfig call hardens against any future parseConfig changes.
  const config = parseConfig(json);
  validateConfig(config);
  return config;
}
