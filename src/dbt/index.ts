/**
 * Wave 2a entry point — dbt cleanup loop.
 *
 * OWNED BY: Wave 2a. This file is a LOCKED scaffold: the `DbtModule` shape and
 * the `createDbtModule` factory signature are fixed so the orchestrator
 * (Wave 2c) can wire it. Wave 2a fills in the bodies; do not change the
 * exported signature without Lead approval.
 *
 * Responsibilities:
 *  - Detector:     read dbt artifacts (manifest/catalog/run_results) + Snowflake
 *                  usage (via a mockable connector) and flag stale/low-usage models.
 *  - SafetyAnalyzer: check downstream lineage, exposures, recent reads, ownership.
 *  - Recommender:  emit `dbt-deprecate` Recommendations with FileChanges.
 */

import type { Detector, Recommender, SafetyAnalyzer } from '../contracts/index.js';
import { DbtDetector } from './detector.js';
import { DbtSafetyAnalyzer } from './analyzer.js';
import { DbtRecommender } from './recommender.js';

export interface DbtModule {
  detector: Detector;
  analyzer: SafetyAnalyzer;
  recommender: Recommender;
}

/**
 * Factory the orchestrator imports to obtain the dbt pipeline stages.
 * Per-run config/logger arrive via `RunContext` on each stage call.
 */
export function createDbtModule(): DbtModule {
  return {
    detector: new DbtDetector(),
    analyzer: new DbtSafetyAnalyzer(),
    recommender: new DbtRecommender(),
  };
}
