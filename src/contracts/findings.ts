/**
 * Domain core contracts: findings, safety assessments, recommendations.
 *
 * ============================ LOCKED ============================
 * These types are the shared contract surface for the whole agent.
 * Wave 2 (dbt / k8s / orchestration) MUST code against these and MUST NOT
 * change them without explicit Lead approval.
 * ================================================================
 */

/** Cleanup domains supported by the MVP. */
export type Domain = 'dbt' | 'kubernetes';

/** Coarse severity of a finding/recommendation. */
export type Severity = 'low' | 'medium' | 'high';

/** Coarse confidence bucket derived from the numeric score. */
export type ConfidenceLevel = 'low' | 'medium' | 'high';

/**
 * Confidence in a safety assessment or recommendation.
 * `score` is the source of truth (0..1); `level` is a derived convenience.
 * Use `confidence()` from `src/core/confidence` to construct normalized values.
 */
export interface Confidence {
  /** Normalized confidence in the inclusive range [0, 1]. */
  score: number;
  /** Coarse bucket derived from `score`. */
  level: ConfidenceLevel;
  /** Optional human-readable explanation of how the score was derived. */
  rationale?: string;
}

/**
 * A single piece of explainable evidence (usage stats, lineage, utilization,
 * OOM history, etc.). `data` carries structured detail for the PR body.
 */
export interface Evidence {
  /** Stable machine key, e.g. `snowflake-reads`, `dbt-downstream`, `k8s-p95`. */
  kind: string;
  /** Short human-readable summary line. */
  summary: string;
  /** Optional structured payload backing the summary. */
  data?: Record<string, unknown>;
}

/**
 * A detected cleanup candidate, before safety analysis.
 * `targetRef` identifies the thing under review:
 *  - dbt:        the model unique id or path (e.g. `model.shop.stale_orders`).
 *  - kubernetes: a workload ref (e.g. `deployment/prod/api` => kind/namespace/name).
 */
export interface Finding {
  /** Stable, dedupable id (see `stableId` in `src/core/id`). */
  id: string;
  domain: Domain;
  /** Model unique id/path, or workload reference. */
  targetRef: string;
  /** Short human-readable title. */
  title: string;
  /** Optional coarse severity hint from the detector. */
  severity?: Severity;
  /** Detection signals that justify the candidate. */
  signals: Evidence[];
  /** ISO-8601 timestamp of detection. */
  detectedAt: string;
}

/**
 * Output of a SafetyAnalyzer: whether the candidate is safe to act on,
 * with confidence, supporting reasons, and hard blockers.
 */
export interface SafetyAssessment {
  /** True only if no blockers and confidence is acceptable. */
  safe: boolean;
  confidence: Confidence;
  /** Evidence supporting the safe/unsafe verdict (lineage, recency, etc.). */
  reasons: Evidence[];
  /** Hard reasons the agent must not proceed (e.g. active downstream, recent OOM). */
  blockers: string[];
}

/** A concrete file edit a recommendation proposes (never applied directly). */
export interface FileChange {
  /** Repo-relative path. */
  path: string;
  kind: 'create' | 'modify';
  /** Human-readable description of the change for the PR body. */
  description: string;
  /** Full new file content (for small files / `create`). */
  newContent?: string;
  /** Unified diff patch (for surgical `modify`). */
  patch?: string;
}

/** Estimated impact of applying a recommendation (cost/complexity reduction). */
export interface ImpactEstimate {
  description: string;
  /** Machine key for the metric, e.g. `memory-mib`, `monthly-usd`. */
  metric?: string;
  estimatedValue?: number;
  /** Unit for `estimatedValue`, e.g. `MiB`, `USD/month`. */
  unit?: string;
}

/** Deprecate (or flag for review) a stale/low-usage dbt model. */
export interface DbtDeprecateAction {
  type: 'dbt-deprecate';
  /** dbt model unique id, e.g. `model.shop.stale_orders`. */
  model: string;
  /**
   * What the PR actually does. `flag-for-review` only annotates; `deprecate`
   * adds deprecation metadata/docs; `disable` is only emitted where a safe
   * disable workflow exists.
   */
  mode: 'flag-for-review' | 'deprecate' | 'disable';
  changes: FileChange[];
}

/** Right-size memory for an overprovisioned Kubernetes workload. */
export interface K8sMemoryResizeAction {
  type: 'k8s-memory-resize';
  /** Workload ref, e.g. `deployment/prod/api`. */
  workload: string;
  /** Container within the workload. */
  container: string;
  /** Current memory request as a Kubernetes quantity string, e.g. `1Gi`. */
  currentRequest: string;
  /** Proposed memory request as a Kubernetes quantity string, e.g. `640Mi`. */
  proposedRequest: string;
  /** Optionally adjust the limit too; omitted means "requests only". */
  currentLimit?: string;
  proposedLimit?: string;
  changes: FileChange[];
}

/**
 * Discriminated union of concrete actions a recommendation may carry.
 * Extend by adding new members with a unique `type`; existing members are LOCKED.
 */
export type RecommendationAction = DbtDeprecateAction | K8sMemoryResizeAction;

/**
 * A safe, reviewable change proposal derived from a finding + its assessment.
 * `recommend()` returns `null` when nothing safe can be proposed.
 */
export interface Recommendation {
  id: string;
  finding: Finding;
  assessment: SafetyAssessment;
  action: RecommendationAction;
  estimatedImpact?: ImpactEstimate;
  /** Plain-language rollback instructions included in every PR. */
  rollback: string;
}
