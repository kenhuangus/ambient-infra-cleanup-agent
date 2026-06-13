# CONTRACTS — Ambient Infra Cleanup Agent (Wave 1)

> **THESE CONTRACTS ARE LOCKED.** Wave 2 (dbt / k8s / orchestration) MUST code
> against these exact types and factory signatures and **MUST NOT change
> anything under `src/contracts/**` or `src/core/**` without explicit Lead
> approval.** If a contract genuinely blocks you, stop and request a Lead
> change — do not work around it by editing the locked files.

The agent is **recommend-only**: read-only analysis in; review-ready pull
request drafts out. It never mutates Snowflake, dbt, or Kubernetes.

Pipeline shape (the seams between waves):

```
Detector → SafetyAnalyzer → Recommender → PrGenerator
   (per domain)                              (shared)
        ↑ dedup / lifecycle via StateStore ↑
        all stages receive a RunContext
```

---

## 1. File ownership

| Path | Owner | May edit? |
| --- | --- | --- |
| `src/contracts/**` | Wave 1 (Lead) | ❌ Locked — Lead approval only |
| `src/core/**` | Wave 1 (Lead) | ❌ Locked — Lead approval only (import freely) |
| `src/dbt/**` | **Wave 2a** | ✅ implement bodies; keep `createDbtModule` signature |
| `src/k8s/**` | **Wave 2b** | ✅ implement bodies; keep `createK8sModule` signature |
| `src/orchestration/**` + `src/cli.ts` | **Wave 2c** | ✅ implement bodies; keep exported signatures |
| `package.json`, `tsconfig.json`, `.gitignore` | Wave 1 | ⚠️ additive only (new deps/scripts), ask before structural changes |
| `fixtures/**` | Wave 2 (per domain) | ✅ add real fixtures |
| `test/**` | All | ✅ add tests (don't weaken the smoke test) |

**Domain responsibilities**

- **Wave 2a — `src/dbt/**`**: dbt `Detector`, `SafetyAnalyzer`, `Recommender`.
  Reads dbt artifacts (`manifest.json`, `catalog.json`, `run_results.json`)
  and Snowflake usage via a **mockable** connector (`config.connectors.dbt`).
  Produces `Recommendation`s with `dbt-deprecate` actions + `FileChange[]`.
- **Wave 2b — `src/k8s/**`**: k8s `Detector`, `SafetyAnalyzer`, `Recommender`.
  Reads utilization metrics via a **mockable** connector
  (`config.connectors.k8s.metrics`). Produces `Recommendation`s with
  `k8s-memory-resize` actions editing manifests under `manifestsDir`.
- **Wave 2c — `src/orchestration/**` + `src/cli.ts`**: config loader,
  `StateStore` impl, GitHub `PrGenerator` (honoring `dryRun`),
  the runner that wires `Detectors → Analyzers → Recommenders → PrGenerator`
  with dedup, and the summary reporter / CLI.

---

## 2. Factory signatures Wave 2 implements / Wave 2c imports

These are **locked**. Wave 2c wires the modules by importing these factories.

### `src/dbt/index.ts` (Wave 2a)
```ts
export interface DbtModule {
  detector: Detector;
  analyzer: SafetyAnalyzer;
  recommender: Recommender;
}
export function createDbtModule(): DbtModule;
```

### `src/k8s/index.ts` (Wave 2b)
```ts
export interface K8sModule {
  detector: Detector;
  analyzer: SafetyAnalyzer;
  recommender: Recommender;
}
export function createK8sModule(): K8sModule;
```

### `src/orchestration/index.ts` (Wave 2c)
```ts
export interface PipelineModules {
  detectors: Detector[];
  analyzers: SafetyAnalyzer[];
  recommenders: Recommender[];
  prGenerator: PrGenerator;
}
export interface DomainRunStats { detected: number; safe: number; recommended: number; skipped: number; }
export interface RunReport {
  runId: string;
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  stats: Record<string, DomainRunStats>;
  prResults: PrGenerationResult[];
}
export interface Runner { run(): Promise<RunReport>; }

export function loadConfig(source?: string): Promise<AgentConfig>;
export function createRunContext(config: AgentConfig): RunContext;
export function createStateStore(stateDir?: string): StateStore;
export function createGithubPrGenerator(): PrGenerator;
export function createRunner(
  ctx: RunContext,
  modules: PipelineModules,
  stateStore: StateStore,
): Runner;
```

> Per-run `config`/`logger`/`now`/`dryRun` are delivered to every stage via
> the `RunContext` argument on each method call — that is why the domain
> factories take no arguments.

---

## 3. Locked contract surface

All of the following are re-exported from **`src/contracts/index.ts`**.
Import from there: `import { ... } from '../contracts/index.js';`
(Note the `.js` extension — required by NodeNext ESM resolution.)

### Domain core — `src/contracts/findings.ts`
```ts
export type Domain = 'dbt' | 'kubernetes';
export type Severity = 'low' | 'medium' | 'high';
export type ConfidenceLevel = 'low' | 'medium' | 'high';

export interface Confidence {
  score: number;            // normalized [0, 1] — source of truth
  level: ConfidenceLevel;   // derived bucket
  rationale?: string;
}

export interface Evidence {
  kind: string;                          // machine key, e.g. 'snowflake-reads'
  summary: string;                       // human-readable line
  data?: Record<string, unknown>;        // structured backing detail
}

export interface Finding {
  id: string;                 // stable, dedupable (see core stableId)
  domain: Domain;
  targetRef: string;          // dbt model unique id/path OR k8s workload ref
  title: string;
  severity?: Severity;
  signals: Evidence[];
  detectedAt: string;         // ISO-8601
}

export interface SafetyAssessment {
  safe: boolean;
  confidence: Confidence;
  reasons: Evidence[];
  blockers: string[];         // hard stop reasons
}

export interface FileChange {
  path: string;
  kind: 'create' | 'modify';
  description: string;
  newContent?: string;        // full content (create / small files)
  patch?: string;             // unified diff (surgical modify)
}

export interface ImpactEstimate {
  description: string;
  metric?: string;            // e.g. 'memory-mib', 'monthly-usd'
  estimatedValue?: number;
  unit?: string;              // e.g. 'MiB', 'USD/month'
}

export interface DbtDeprecateAction {
  type: 'dbt-deprecate';
  model: string;                                       // dbt unique id
  mode: 'flag-for-review' | 'deprecate' | 'disable';
  changes: FileChange[];
}

export interface K8sMemoryResizeAction {
  type: 'k8s-memory-resize';
  workload: string;           // e.g. 'deployment/prod/api'
  container: string;
  currentRequest: string;     // k8s quantity, e.g. '1Gi'
  proposedRequest: string;    // k8s quantity, e.g. '640Mi'
  currentLimit?: string;      // omit => requests-only
  proposedLimit?: string;
  changes: FileChange[];
}

export type RecommendationAction = DbtDeprecateAction | K8sMemoryResizeAction;

export interface Recommendation {
  id: string;
  finding: Finding;
  assessment: SafetyAssessment;
  action: RecommendationAction;
  estimatedImpact?: ImpactEstimate;
  rollback: string;           // plain-language rollback (every PR includes this)
}
```

### PR drafts — `src/contracts/pr.ts`
```ts
export interface PullRequestDraft {
  id: string;
  title: string;
  body: string;               // markdown: evidence, lineage/util, impact, risk, rollback
  branch: string;
  labels: string[];
  changes: FileChange[];
  sourceRecommendationIds: string[];
}

export interface PrGenerationResult {
  draft: PullRequestDraft;
  url?: string;               // set when actually opened
  dryRun: boolean;
  opened: boolean;
  error?: string;
}
```

### Pipeline seams — `src/contracts/pipeline.ts`
```ts
export interface RunContext {
  config: AgentConfig;
  logger: Logger;
  now: () => Date;            // injectable clock — use instead of new Date()
  dryRun: boolean;            // mirrors config.pr.dryRun
  runId: string;
}

export interface Detector {
  domain: Domain;
  detect(ctx: RunContext): Promise<Finding[]>;
}

export interface SafetyAnalyzer {
  domain: Domain;
  assess(finding: Finding, ctx: RunContext): Promise<SafetyAssessment>;
}

export interface Recommender {
  domain: Domain;
  recommend(
    finding: Finding,
    assessment: SafetyAssessment,
    ctx: RunContext,
  ): Promise<Recommendation | null>;   // null => nothing safe to propose
}

export interface PrGenerator {
  generate(
    recommendations: Recommendation[],
    ctx: RunContext,
  ): Promise<PrGenerationResult[]>;
}

export type FindingState =
  | 'detected' | 'proposed' | 'accepted' | 'rejected' | 'merged' | 'reverted';

export interface KnownFinding {
  findingId: string;          // === Finding.id
  domain: Domain;
  targetRef: string;
  state: FindingState;
  firstSeenAt: string;        // ISO-8601
  lastSeenAt: string;
  prDraftId?: string;
  prUrl?: string;
  notes?: string;
}

export interface StateStore {
  getKnown(): Promise<KnownFinding[]>;
  get(findingId: string): Promise<KnownFinding | undefined>;
  record(entries: KnownFinding[]): Promise<void>;            // upsert by findingId
  markState(findingId: string, state: FindingState, notes?: string): Promise<void>;
}
```

### Config — `src/contracts/config.ts`
```ts
export interface DbtThresholds {
  staleDays: number;
  lowReadCountPerDays: number;
  lowReadWindowDays: number;
  flagWithoutDownstream: boolean;
}

export interface K8sThresholds {
  percentile: number;         // e.g. 95
  bufferPct: number;          // safety buffer added on top of percentile
  minMemoryMiB: number;       // floor
  lookbackDays: number;
  recentOomDays: number;      // skip if OOM within N days
  maxRestarts: number;        // skip if restarts over window exceed this
  minSavingsFraction: number; // only propose if savings >= this fraction (0..1)
}

export type ConnectorMode = 'mock' | 'live';   // 'mock' reads fixtures from disk

export interface DbtConnectorConfig {
  mode: ConnectorMode;
  artifactDir: string;        // manifest/catalog/run_results location
  snowflake: {
    mode: ConnectorMode;
    mockPath?: string;        // fixtures file when mock
    account?: string;
    database?: string;
    credentialsEnv?: string;  // env var NAME for live creds
  };
}

export interface K8sConnectorConfig {
  metrics: {
    mode: ConnectorMode;
    endpoint?: string;        // e.g. Prometheus, for live
    mockPath?: string;        // fixtures file when mock
    credentialsEnv?: string;
  };
  manifestsDir: string;       // manifests / Helm / Kustomize the PRs edit
}

export interface GithubConnectorConfig {
  mode: ConnectorMode;
  repo: string;               // 'owner/repo'
  baseBranch: string;
  tokenEnv: string;           // env var NAME holding the token (never the token)
}

export interface ConnectorConfig {
  dbt: DbtConnectorConfig;
  k8s: K8sConnectorConfig;
  github: GithubConnectorConfig;
}

export interface PrConfig {
  dryRun: boolean;
  maxPrsPerRun: number;
  labels: string[];
  branchPrefix: string;
  minConfidenceToOpen: number;  // [0, 1]
}

export interface AgentConfig {
  dbt: DbtThresholds;
  k8s: K8sThresholds;
  excludedDbtModels: string[];
  excludedNamespaces: string[];
  pr: PrConfig;
  connectors: ConnectorConfig;
  enabledDomains: Array<'dbt' | 'kubernetes'>;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export const defaultConfig: AgentConfig;            // conservative: dryRun + mock
export function parseConfig(json: unknown): AgentConfig;   // deep-merge w/ defaults + validate
export function validateConfig(config: AgentConfig): void; // throws on bad ranges
```

> Wave 1 ships a working `parseConfig` (deep-merge-with-defaults + light range
> validation). Wave 2c may **harden** validation but must keep the signature
> and the merge-with-`defaultConfig` behavior.

### Logger — `src/core/logger.ts` (re-exported via contracts)
```ts
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

export function createLogger(options?: {
  level?: LogLevel;
  base?: LogFields;
  sink?: (level: LogLevel, line: string) => void;
}): Logger;
```

---

## 4. Other core utilities (import freely, don't edit)

`src/core/index.ts` also exports:

- **Result** (`src/core/result.ts`): `Result<T,E>`, `Ok<T>`, `Err<E>`,
  `ok`, `err`, `isOk`, `isErr`, `unwrap`, `unwrapOr`, `tryCatch`, `tryCatchAsync`.
- **Confidence** (`src/core/confidence.ts`): `confidence(score, rationale?)`,
  `levelFromScore`, `clamp01`, `CONFIDENCE_THRESHOLDS`.
- **Id/hash** (`src/core/id.ts`): `stableId(prefix, ...parts)`,
  `shortHash`, `hash`, `randomId`, `slug` — use `stableId` so `Finding.id`
  dedups across runs.

---

## 5. Conventions Wave 2 must follow

1. **Import shared types from `src/contracts/index.js`** (with `.js` suffix).
2. **Use `RunContext`** for config/logger/clock/dryRun. Do not read env or call
   `new Date()` directly — use `ctx.now()` so tests are deterministic.
3. **Stable ids**: build `Finding.id` with `stableId('dbt'|'k8s', targetRef, ...)`.
4. **Honor `dryRun`**: the PR generator must not open real PRs when
   `ctx.dryRun` (or `config.pr.dryRun`) is true.
5. **Respect exclusions/thresholds** from `config` (`excludedDbtModels`,
   `excludedNamespaces`, `dbt.*`, `k8s.*`, `pr.minConfidenceToOpen`).
6. **Read-only**: connectors never mutate source systems. Output is always
   `FileChange[]` inside a `PullRequestDraft`.
7. **`recommend()` returns `null`** when nothing safe can be proposed.

---

## 6. Build / verify gate

```
npm install
npm run typecheck   # tsc --noEmit
npm run build       # tsc -> dist/
npm test            # vitest run (test/smoke.test.ts)
npm start           # node dist/cli.js (banner, exit 0)
```

All must stay green. Do not weaken `test/smoke.test.ts`; add your own tests
alongside it.
