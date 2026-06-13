/**
 * Confidence helpers — build/normalize the `Confidence` value object used by
 * safety assessments and recommendations.
 *
 * OWNED BY: Wave 1 (Lead-approval required to change).
 */

import type { Confidence, ConfidenceLevel } from '../contracts/findings.js';

/** Default score boundaries for the three confidence levels. */
export const CONFIDENCE_THRESHOLDS = {
  /** score < low.below => 'low' */
  mediumAtOrAbove: 0.5,
  highAtOrAbove: 0.8,
} as const;

/** Clamp an arbitrary number into the inclusive [0, 1] range. */
export function clamp01(score: number): number {
  if (Number.isNaN(score)) return 0;
  if (score < 0) return 0;
  if (score > 1) return 1;
  return score;
}

/** Map a 0..1 score to a coarse level using the default thresholds. */
export function levelFromScore(score: number): ConfidenceLevel {
  const s = clamp01(score);
  if (s >= CONFIDENCE_THRESHOLDS.highAtOrAbove) return 'high';
  if (s >= CONFIDENCE_THRESHOLDS.mediumAtOrAbove) return 'medium';
  return 'low';
}

/** Build a normalized `Confidence` from a raw score (and optional rationale). */
export function confidence(score: number, rationale?: string): Confidence {
  const normalized = clamp01(score);
  return {
    score: normalized,
    level: levelFromScore(normalized),
    ...(rationale === undefined ? {} : { rationale }),
  };
}
