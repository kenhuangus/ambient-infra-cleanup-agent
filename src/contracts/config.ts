/**
 * Agent configuration contract + defaults.
 *
 * ============================ LOCKED ============================
 * The `AgentConfig` shape and the `parseConfig` signature are LOCKED.
 * Wave 2c (orchestration) implements the real loader/validator but must keep
 * this signature and shape. Wave 2a/2b read config off `RunContext.config`.
 * ================================================================
 */

/** Thresholds for flagging stale / low-usage dbt models. */
export interface DbtThresholds {
  /** Flag if no successful materialization within this many days. */
  staleDays: number;
  /** "Low usage" means fewer than this many reads ... */
  lowReadCountPerDays: number;
  /** ... within this rolling window (days). */
  lowReadWindowDays: number;
  /** Flag models that have no exposures and no downstream dependents. */
  flagWithoutDownstream: boolean;
}

/** Thresholds for flagging overprovisioned Kubernetes memory. */
export interface K8sThresholds {
  /** Percentile of historical usage to size against (e.g. 95 => p95). */
  percentile: number;
  /** Safety buffer added on top of the percentile usage, as a percent. */
  bufferPct: number;
  /** Never propose a request below this floor (MiB). */
  minMemoryMiB: number;
  /** Window of utilization history to evaluate (days). */
  lookbackDays: number;
  /** Skip workloads with an OOM kill within this many days. */
  recentOomDays: number;
  /** Skip workloads whose restart count over the window exceeds this. */
  maxRestarts: number;
  /** Only propose when projected savings meet at least this fraction (0..1). */
  minSavingsFraction: number;
}

/** How a connector obtains its data. `mock` reads fixtures from disk. */
export type ConnectorMode = 'mock' | 'live';

/** dbt artifacts + Snowflake usage connector config. */
export interface DbtConnectorConfig {
  mode: ConnectorMode;
  /** Directory containing manifest.json / catalog.json / run_results.json. */
  artifactDir: string;
  /** Snowflake usage source. In `mock` mode this points at a fixtures file. */
  snowflake: {
    mode: ConnectorMode;
    /** Path to a fixtures JSON file when `mode === 'mock'`. */
    mockPath?: string;
    /** Account usage/database identifiers for `live` mode (env-resolved). */
    account?: string;
    database?: string;
    /** Env var name holding credentials for `live` mode. */
    credentialsEnv?: string;
  };
}

/** Kubernetes metrics + manifests connector config. */
export interface K8sConnectorConfig {
  /** How to read utilization metrics. */
  metrics: {
    mode: ConnectorMode;
    /** Metrics backend endpoint (e.g. Prometheus) for `live` mode. */
    endpoint?: string;
    /** Path to a fixtures JSON file when `mode === 'mock'`. */
    mockPath?: string;
    /** Env var name holding metrics-backend credentials for `live` mode. */
    credentialsEnv?: string;
  };
  /** Directory of Kubernetes manifests / Helm / Kustomize the PRs edit. */
  manifestsDir: string;
}

/** Git host (GitHub for MVP) connector config. */
export interface GithubConnectorConfig {
  mode: ConnectorMode;
  /** `owner/repo` of the target repository. */
  repo: string;
  /** Default base branch PRs target. */
  baseBranch: string;
  /** Env var NAME that holds the token (never the token itself). */
  tokenEnv: string;
}

export interface ConnectorConfig {
  dbt: DbtConnectorConfig;
  k8s: K8sConnectorConfig;
  github: GithubConnectorConfig;
}

/** Pull-request behavior / contribution policy. */
export interface PrConfig {
  /** When true, never open real PRs — report drafts only. */
  dryRun: boolean;
  /** Cap on PRs opened per run (batching / anti-spam). */
  maxPrsPerRun: number;
  /** Labels applied to every generated PR (e.g. AI-cleanup labeling). */
  labels: string[];
  /** Prefix for generated branch names, e.g. `infra-cleanup`. */
  branchPrefix: string;
  /** Minimum confidence score (0..1) required before opening a PR. */
  minConfidenceToOpen: number;
}

/**
 * Top-level agent configuration. Mirrors the PRD's MVP config file.
 */
export interface AgentConfig {
  dbt: DbtThresholds;
  k8s: K8sThresholds;
  /** dbt model unique ids/paths the agent must never touch. */
  excludedDbtModels: string[];
  /** Kubernetes namespaces the agent must never touch. */
  excludedNamespaces: string[];
  pr: PrConfig;
  connectors: ConnectorConfig;
  /** Domains enabled for this run. */
  enabledDomains: Array<'dbt' | 'kubernetes'>;
  /** Logger level. */
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

/** Conservative defaults. Safe to ship: dry-run on, mock connectors. */
export const defaultConfig: AgentConfig = {
  dbt: {
    staleDays: 90,
    lowReadCountPerDays: 5,
    lowReadWindowDays: 30,
    flagWithoutDownstream: true,
  },
  k8s: {
    percentile: 95,
    bufferPct: 30,
    minMemoryMiB: 64,
    lookbackDays: 14,
    recentOomDays: 7,
    maxRestarts: 5,
    minSavingsFraction: 0.15,
  },
  excludedDbtModels: [],
  excludedNamespaces: ['kube-system'],
  pr: {
    dryRun: true,
    maxPrsPerRun: 5,
    labels: ['ai-infra-cleanup', 'automated'],
    branchPrefix: 'infra-cleanup',
    minConfidenceToOpen: 0.8,
  },
  connectors: {
    dbt: {
      mode: 'mock',
      artifactDir: 'fixtures/dbt',
      snowflake: {
        mode: 'mock',
        mockPath: 'fixtures/dbt/snowflake_usage.json',
      },
    },
    k8s: {
      metrics: {
        mode: 'mock',
        mockPath: 'fixtures/k8s/metrics.json',
      },
      manifestsDir: 'fixtures/k8s/manifests',
    },
    github: {
      mode: 'mock',
      repo: 'example-org/example-repo',
      baseBranch: 'main',
      tokenEnv: 'GITHUB_TOKEN',
    },
  },
  enabledDomains: ['dbt', 'kubernetes'],
  logLevel: 'info',
};

/**
 * Parse + validate raw config (e.g. parsed JSON/YAML), merging with
 * `defaultConfig`. Should throw on invalid types/ranges.
 *
 * Wave 1 ships a light merge-and-validate implementation so the scaffold has a
 * working entry point; Wave 2c may harden validation but MUST keep this
 * signature and the deep-merge-with-defaults behavior.
 */
export function parseConfig(json: unknown): AgentConfig {
  if (json === null || json === undefined) return clone(defaultConfig);
  if (typeof json !== 'object' || Array.isArray(json)) {
    throw new TypeError('config must be a JSON object');
  }
  const merged = deepMerge(
    clone(defaultConfig) as unknown as JsonRecord,
    json as JsonRecord,
  ) as unknown as AgentConfig;
  validateConfig(merged);
  return merged;
}

/** Light range/shape validation. Throws on the first violation. */
export function validateConfig(config: AgentConfig): void {
  const c = config.pr.minConfidenceToOpen;
  if (c < 0 || c > 1) {
    throw new RangeError('pr.minConfidenceToOpen must be within [0, 1]');
  }
  if (config.pr.maxPrsPerRun < 0) {
    throw new RangeError('pr.maxPrsPerRun must be >= 0');
  }
  if (config.k8s.percentile <= 0 || config.k8s.percentile >= 100) {
    throw new RangeError('k8s.percentile must be within (0, 100)');
  }
  if (config.k8s.minMemoryMiB <= 0) {
    throw new RangeError('k8s.minMemoryMiB must be > 0');
  }
  if (config.dbt.staleDays <= 0) {
    throw new RangeError('dbt.staleDays must be > 0');
  }
  if (config.enabledDomains.length === 0) {
    throw new RangeError('enabledDomains must contain at least one domain');
  }
}

type JsonRecord = Record<string, unknown>;

function isPlainObject(v: unknown): v is JsonRecord {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function clone<T>(v: T): T {
  return structuredClone(v);
}

/** Recursively merge `source` onto `target` (arrays/scalars overwrite). */
function deepMerge(target: JsonRecord, source: JsonRecord): JsonRecord {
  for (const [key, value] of Object.entries(source)) {
    const existing = target[key];
    if (isPlainObject(value) && isPlainObject(existing)) {
      target[key] = deepMerge(existing, value);
    } else {
      target[key] = value;
    }
  }
  return target;
}
