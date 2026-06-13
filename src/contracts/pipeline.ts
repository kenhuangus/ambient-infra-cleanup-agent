/**
 * Pipeline seam interfaces — the contracts BETWEEN the Wave 2 agents.
 *
 * ============================ LOCKED ============================
 * Detector / SafetyAnalyzer / Recommender / PrGenerator / StateStore /
 * RunContext are the integration boundaries. Wave 2a (dbt), Wave 2b (k8s),
 * and Wave 2c (orchestration) all depend on these exact shapes. Changing
 * them requires explicit Lead approval.
 * ================================================================
 */

import type { Logger } from '../core/logger.js';
import type { AgentConfig } from './config.js';
import type {
  Domain,
  Finding,
  Recommendation,
  SafetyAssessment,
} from './findings.js';
import type { PrGenerationResult } from './pr.js';

/**
 * Per-run execution context handed to every stage. Carries resolved config,
 * a logger, an injectable clock (for deterministic tests), and the dry-run
 * flag (mirrors `config.pr.dryRun`, hoisted for convenience).
 */
export interface RunContext {
  config: AgentConfig;
  logger: Logger;
  /** Injectable clock; stages must use this instead of `new Date()`. */
  now: () => Date;
  /** Convenience mirror of `config.pr.dryRun`. */
  dryRun: boolean;
  /** Opaque id for correlating logs/state within a single run. */
  runId: string;
}

/** Stage 1: find candidates for a domain. */
export interface Detector {
  domain: Domain;
  detect(ctx: RunContext): Promise<Finding[]>;
}

/** Stage 2: assess whether a candidate is safe to act on. */
export interface SafetyAnalyzer {
  domain: Domain;
  assess(finding: Finding, ctx: RunContext): Promise<SafetyAssessment>;
}

/** Stage 3: turn a safe candidate into a concrete recommendation (or skip). */
export interface Recommender {
  domain: Domain;
  recommend(
    finding: Finding,
    assessment: SafetyAssessment,
    ctx: RunContext,
  ): Promise<Recommendation | null>;
}

/** Stage 4: batch recommendations into review-ready PR drafts (and open them). */
export interface PrGenerator {
  generate(
    recommendations: Recommendation[],
    ctx: RunContext,
  ): Promise<PrGenerationResult[]>;
}

/** Lifecycle state of a finding across runs. */
export type FindingState =
  | 'detected'
  | 'proposed'
  | 'accepted'
  | 'rejected'
  | 'merged'
  | 'reverted';

/**
 * Persisted record of a finding for dedup + lifecycle tracking.
 * `findingId` matches `Finding.id` (stable across runs).
 */
export interface KnownFinding {
  findingId: string;
  domain: Domain;
  targetRef: string;
  state: FindingState;
  /** ISO-8601 timestamps. */
  firstSeenAt: string;
  lastSeenAt: string;
  /** PR draft id / url once a PR has been proposed. */
  prDraftId?: string;
  prUrl?: string;
  /** Free-form notes for audit (e.g. why rejected). */
  notes?: string;
}

/** Persistence for finding lifecycle + dedup. Wave 2c implements this. */
export interface StateStore {
  /** All previously-known findings. */
  getKnown(): Promise<KnownFinding[]>;
  /** Look up a single known finding by id, if present. */
  get(findingId: string): Promise<KnownFinding | undefined>;
  /** Upsert lifecycle records (create or update by `findingId`). */
  record(entries: KnownFinding[]): Promise<void>;
  /** Transition a single finding to a new lifecycle state. */
  markState(findingId: string, state: FindingState, notes?: string): Promise<void>;
}
