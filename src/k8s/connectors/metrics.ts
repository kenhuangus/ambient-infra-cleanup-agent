/**
 * Kubernetes utilization metrics connector (Wave 2b).
 *
 * In `mock` mode it reads a JSON fixtures file (an array of workload metric
 * records) from `config.connectors.k8s.metrics.mockPath`. `live` mode is not
 * implemented in the MVP and throws.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { RunContext } from '../../contracts/index.js';

/** One workload's utilization snapshot, as supplied by the metrics backend. */
export interface K8sWorkloadMetric {
  /** Workload ref, e.g. `deployment/prod/api` (kind/namespace/name). */
  workload: string;
  namespace: string;
  container: string;
  /** Current memory request as a Kubernetes quantity, e.g. `1Gi`. */
  requestMemory: string;
  /** Current memory limit, if declared. */
  limitMemory?: string;
  /** Per-interval memory usage samples over the lookback window (MiB). */
  usageSamplesMiB: number[];
  /** Number of OOM kills observed over the window. */
  oomKills: number;
  /** ISO-8601 timestamp of the most recent OOM kill, if any. */
  lastOomAt?: string;
  /** Restart count over the window. */
  restarts: number;
  /** Manifest path (relative to `manifestsDir`) the PR would edit. */
  manifestPath: string;
}

const LIVE_NOT_IMPLEMENTED =
  'Kubernetes metrics live mode not implemented in MVP — use mock';

/** Load workload metrics for the run, honoring the configured connector mode. */
export async function loadK8sMetrics(ctx: RunContext): Promise<K8sWorkloadMetric[]> {
  const cfg = ctx.config.connectors.k8s.metrics;
  if (cfg.mode === 'live') {
    throw new Error(LIVE_NOT_IMPLEMENTED);
  }
  if (cfg.mockPath === undefined || cfg.mockPath.length === 0) {
    throw new Error(
      'k8s metrics mock mode requires connectors.k8s.metrics.mockPath',
    );
  }
  const absPath = resolve(cfg.mockPath);
  const raw = await readFile(absPath, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`k8s metrics fixture must be a JSON array: ${absPath}`);
  }
  return parsed.map((record, index) => parseMetric(record, index, absPath));
}

function parseMetric(record: unknown, index: number, source: string): K8sWorkloadMetric {
  if (typeof record !== 'object' || record === null) {
    throw new Error(`k8s metric #${index} must be an object (${source})`);
  }
  const r = record as Record<string, unknown>;
  const workload = requireString(r.workload, `metric #${index} workload`, source);
  const namespace = requireString(r.namespace, `${workload} namespace`, source);
  const container = requireString(r.container, `${workload} container`, source);
  const requestMemory = requireString(
    r.requestMemory,
    `${workload} requestMemory`,
    source,
  );
  const manifestPath = requireString(
    r.manifestPath,
    `${workload} manifestPath`,
    source,
  );
  if (!Array.isArray(r.usageSamplesMiB) || !r.usageSamplesMiB.every(isFiniteNumber)) {
    throw new Error(`${workload} usageSamplesMiB must be a number[] (${source})`);
  }

  return {
    workload,
    namespace,
    container,
    requestMemory,
    ...(typeof r.limitMemory === 'string' ? { limitMemory: r.limitMemory } : {}),
    usageSamplesMiB: r.usageSamplesMiB,
    oomKills: isFiniteNumber(r.oomKills) ? r.oomKills : 0,
    ...(typeof r.lastOomAt === 'string' ? { lastOomAt: r.lastOomAt } : {}),
    restarts: isFiniteNumber(r.restarts) ? r.restarts : 0,
    manifestPath,
  };
}

function requireString(value: unknown, label: string, source: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string (${source})`);
  }
  return value;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
