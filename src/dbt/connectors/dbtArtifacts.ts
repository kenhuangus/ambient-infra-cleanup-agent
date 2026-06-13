/**
 * dbt artifacts connector (read-only).
 *
 * Reads `manifest.json`, `catalog.json`, and `run_results.json` from a directory
 * (`config.connectors.dbt.artifactDir`) and exposes typed lineage / metadata
 * helpers. Optional files (catalog, run_results) are tolerated when missing.
 *
 * Never mutates anything — pure read of CI/local dbt output.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Logger } from '../../contracts/index.js';
import {
  asArray,
  asDate,
  asRecord,
  asString,
  asStringArray,
  isRecord,
  type JsonRecord,
} from './json.js';

export interface DbtModelInfo {
  uniqueId: string;
  name: string;
  /** Project-relative compiled path (manifest `path`). */
  path: string;
  /** Repo-relative source path (manifest `original_file_path`). */
  originalFilePath: string;
  /** Schema yml that documents the model, if any (manifest `patch_path`). */
  patchPath?: string;
  /** Fully-qualified warehouse relation, e.g. DB.SCHEMA.NAME. */
  relationName?: string;
  tags: string[];
  config: JsonRecord;
  resourceType: string;
  dependsOn: string[];
}

export interface DbtExposureInfo {
  uniqueId: string;
  name: string;
  type?: string;
  owner?: string;
  dependsOn: string[];
}

export interface DbtArtifacts {
  listModels(): DbtModelInfo[];
  getModel(uniqueId: string): DbtModelInfo | undefined;
  /** Direct downstream dbt *model* dependents (excludes exposures/tests). */
  downstreamModels(uniqueId: string): string[];
  /** Transitive downstream dbt model dependents. */
  transitiveDownstreamModels(uniqueId: string): string[];
  /** Exposures whose `depends_on` references this model directly. */
  exposuresReferencing(uniqueId: string): DbtExposureInfo[];
  /** Metric unique ids whose `depends_on` references this model directly. */
  metricsReferencing(uniqueId: string): string[];
  /** Test unique ids attached to this model. */
  testsReferencing(uniqueId: string): string[];
  /** Last successful materialization time from run_results, if recorded. */
  lastMaterializedAt(uniqueId: string): Date | undefined;
}

interface ParsedManifest {
  models: Map<string, DbtModelInfo>;
  exposures: DbtExposureInfo[];
  metrics: Map<string, string[]>;
  tests: Map<string, string[]>;
  childMap: Map<string, string[]>;
  parentMap: Map<string, string[]>;
}

function parseModelNode(uniqueId: string, raw: unknown): DbtModelInfo | undefined {
  if (!isRecord(raw)) return undefined;
  const resourceType = asString(raw['resource_type']) ?? 'model';
  const dependsOn = asStringArray(asRecord(raw['depends_on'])['nodes']);
  return {
    uniqueId,
    name: asString(raw['name']) ?? uniqueId,
    path: asString(raw['path']) ?? '',
    originalFilePath: asString(raw['original_file_path']) ?? '',
    ...(asString(raw['patch_path']) === undefined ? {} : { patchPath: asString(raw['patch_path']) }),
    ...(asString(raw['relation_name']) === undefined
      ? {}
      : { relationName: asString(raw['relation_name']) }),
    tags: asStringArray(raw['tags']),
    config: asRecord(raw['config']),
    resourceType,
    dependsOn,
  };
}

function parseExposure(uniqueId: string, raw: unknown): DbtExposureInfo {
  const record = asRecord(raw);
  const owner = asRecord(record['owner']);
  return {
    uniqueId,
    name: asString(record['name']) ?? uniqueId,
    ...(asString(record['type']) === undefined ? {} : { type: asString(record['type']) }),
    ...(asString(owner['name']) === undefined ? {} : { owner: asString(owner['name']) }),
    dependsOn: asStringArray(asRecord(record['depends_on'])['nodes']),
  };
}

function buildMapFromRecord(raw: unknown): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const record = asRecord(raw);
  for (const [key, value] of Object.entries(record)) {
    map.set(key, asStringArray(value));
  }
  return map;
}

function parseManifest(raw: unknown): ParsedManifest {
  const manifest = asRecord(raw);
  const models = new Map<string, DbtModelInfo>();
  const tests = new Map<string, string[]>();

  const nodes = asRecord(manifest['nodes']);
  for (const [uniqueId, node] of Object.entries(nodes)) {
    const parsed = parseModelNode(uniqueId, node);
    if (parsed === undefined) continue;
    if (parsed.resourceType === 'model') {
      models.set(uniqueId, parsed);
    } else if (parsed.resourceType === 'test') {
      for (const parent of parsed.dependsOn) {
        const list = tests.get(parent) ?? [];
        list.push(uniqueId);
        tests.set(parent, list);
      }
    }
  }

  const exposures: DbtExposureInfo[] = [];
  for (const [uniqueId, exposure] of Object.entries(asRecord(manifest['exposures']))) {
    exposures.push(parseExposure(uniqueId, exposure));
  }

  const metrics = new Map<string, string[]>();
  for (const [uniqueId, metric] of Object.entries(asRecord(manifest['metrics']))) {
    const deps = asStringArray(asRecord(asRecord(metric)['depends_on'])['nodes']);
    for (const parent of deps) {
      const list = metrics.get(parent) ?? [];
      list.push(uniqueId);
      metrics.set(parent, list);
    }
  }

  return {
    models,
    exposures,
    metrics,
    tests,
    childMap: buildMapFromRecord(manifest['child_map']),
    parentMap: buildMapFromRecord(manifest['parent_map']),
  };
}

/** Map unique_id -> last `execute` (or last available) completed_at. */
function parseRunResults(raw: unknown): Map<string, Date> {
  const out = new Map<string, Date>();
  const results = asArray(asRecord(raw)['results']);
  for (const result of results) {
    const record = asRecord(result);
    const uniqueId = asString(record['unique_id']);
    if (uniqueId === undefined) continue;
    const timing = asArray(record['timing']);
    let completed: Date | undefined;
    for (const step of timing) {
      const stepRecord = asRecord(step);
      const when = asDate(stepRecord['completed_at']);
      if (when === undefined) continue;
      if (asString(stepRecord['name']) === 'execute') {
        completed = when;
      } else if (completed === undefined) {
        completed = when;
      }
    }
    if (completed !== undefined) out.set(uniqueId, completed);
  }
  return out;
}

async function readJsonFile(filePath: string): Promise<unknown | undefined> {
  try {
    const text = await readFile(filePath, 'utf8');
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Load dbt artifacts from `artifactDir`. `manifest.json` is required; an empty
 * or missing manifest yields a connector with no models (logged as a warning).
 * `catalog.json` and `run_results.json` are optional.
 */
export async function loadDbtArtifacts(
  artifactDir: string,
  logger: Logger,
): Promise<DbtArtifacts> {
  const manifestRaw = await readJsonFile(join(artifactDir, 'manifest.json'));
  if (manifestRaw === undefined) {
    logger.warn('dbt manifest.json not found or unreadable', { artifactDir });
  }
  const runResultsRaw = await readJsonFile(join(artifactDir, 'run_results.json'));
  // catalog.json is read to confirm availability but not required for lineage.
  const catalogRaw = await readJsonFile(join(artifactDir, 'catalog.json'));
  if (catalogRaw === undefined) {
    logger.debug('dbt catalog.json not present; continuing without it', { artifactDir });
  }

  const manifest = parseManifest(manifestRaw);
  const materializedAt = parseRunResults(runResultsRaw);

  const isModelId = (id: string): boolean => manifest.models.has(id);

  function transitive(uniqueId: string): string[] {
    const seen = new Set<string>();
    const queue = [...(manifest.childMap.get(uniqueId) ?? [])];
    while (queue.length > 0) {
      const next = queue.shift();
      if (next === undefined || seen.has(next)) continue;
      seen.add(next);
      for (const child of manifest.childMap.get(next) ?? []) {
        if (!seen.has(child)) queue.push(child);
      }
    }
    return [...seen].filter(isModelId);
  }

  return {
    listModels: () => [...manifest.models.values()],
    getModel: (uniqueId) => manifest.models.get(uniqueId),
    downstreamModels: (uniqueId) =>
      (manifest.childMap.get(uniqueId) ?? []).filter(isModelId),
    transitiveDownstreamModels: (uniqueId) => transitive(uniqueId),
    exposuresReferencing: (uniqueId) =>
      manifest.exposures.filter((exposure) => exposure.dependsOn.includes(uniqueId)),
    metricsReferencing: (uniqueId) => manifest.metrics.get(uniqueId) ?? [],
    testsReferencing: (uniqueId) => manifest.tests.get(uniqueId) ?? [],
    lastMaterializedAt: (uniqueId) => materializedAt.get(uniqueId),
  };
}
