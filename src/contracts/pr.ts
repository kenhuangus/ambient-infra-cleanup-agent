/**
 * Pull-request draft contracts.
 *
 * ============================ LOCKED ============================
 * Wave 2 must not change these without Lead approval.
 * ================================================================
 */

import type { FileChange } from './findings.js';

/**
 * A review-ready pull request the agent proposes. The agent never mutates
 * live systems; this draft is the unit of human-reviewed remediation.
 */
export interface PullRequestDraft {
  /** Stable id for the draft (dedupable across runs). */
  id: string;
  title: string;
  /** Markdown body: evidence, lineage/utilization, impact, risk, rollback. */
  body: string;
  /** Target branch name (typically `${branchPrefix}/...`). */
  branch: string;
  labels: string[];
  /** Concrete file edits the PR would contain. */
  changes: FileChange[];
  /** Recommendation ids this PR batches (one PR may cover several). */
  sourceRecommendationIds: string[];
}

/**
 * Result of attempting to generate/open a PR for a draft.
 * In `dryRun` mode `opened` is false and `url` is undefined.
 */
export interface PrGenerationResult {
  draft: PullRequestDraft;
  /** URL of the opened PR, when actually opened. */
  url?: string;
  /** True when the PR was not opened against the remote (report-only). */
  dryRun: boolean;
  /** True when an actual PR was created on the Git host. */
  opened: boolean;
  /** Populated when generation/opening failed. */
  error?: string;
}
