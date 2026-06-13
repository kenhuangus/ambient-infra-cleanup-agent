/**
 * Shared model analysis. Combines dbt artifacts + Snowflake usage into a single
 * derived view of one model, reused by the detector, safety analyzer, and
 * recommender so they reason from identical signals.
 */

import type { RunContext } from '../contracts/index.js';
import type { DbtData } from './connectors/index.js';
import type { DbtExposureInfo, DbtModelInfo } from './connectors/dbtArtifacts.js';
import type { SnowflakeUsageRecord } from './connectors/snowflakeUsage.js';

const MS_PER_DAY = 86_400_000;

export interface ModelAnalysis {
  model: DbtModelInfo;
  usage?: SnowflakeUsageRecord;
  lastReadAt?: Date;
  /** Whole days since last read; undefined when never read. */
  daysSinceRead?: number;
  readCount: number;
  windowDays: number;
  monthlyComputeUsd?: number;
  lastMaterializedAt?: Date;
  daysSinceMaterialized?: number;
  directDownstreamModels: string[];
  transitiveDownstreamModels: string[];
  exposures: DbtExposureInfo[];
  metrics: string[];
  tests: string[];
}

function wholeDaysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY);
}

/** Build the derived analysis for a single model unique id. */
export function analyzeModel(
  model: DbtModelInfo,
  data: DbtData,
  ctx: RunContext,
): ModelAnalysis {
  const now = ctx.now();
  const { artifacts, usage } = data;

  const usageRecord = usage.get(model.uniqueId, model.relationName);
  const lastReadAt = usage.lastReadAt(model.uniqueId, model.relationName);
  const lastMaterializedAt = artifacts.lastMaterializedAt(model.uniqueId);

  return {
    model,
    ...(usageRecord === undefined ? {} : { usage: usageRecord }),
    ...(lastReadAt === undefined ? {} : { lastReadAt }),
    ...(lastReadAt === undefined ? {} : { daysSinceRead: wholeDaysBetween(lastReadAt, now) }),
    readCount: usageRecord?.readCount ?? 0,
    windowDays: usageRecord?.windowDays ?? 0,
    ...(usageRecord?.monthlyComputeUsd === undefined
      ? {}
      : { monthlyComputeUsd: usageRecord.monthlyComputeUsd }),
    ...(lastMaterializedAt === undefined ? {} : { lastMaterializedAt }),
    ...(lastMaterializedAt === undefined
      ? {}
      : { daysSinceMaterialized: wholeDaysBetween(lastMaterializedAt, now) }),
    directDownstreamModels: artifacts.downstreamModels(model.uniqueId),
    transitiveDownstreamModels: artifacts.transitiveDownstreamModels(model.uniqueId),
    exposures: artifacts.exposuresReferencing(model.uniqueId),
    metrics: artifacts.metricsReferencing(model.uniqueId),
    tests: artifacts.testsReferencing(model.uniqueId),
  };
}

/** True when the model is excluded by unique id, name, or source path. */
export function isExcluded(model: DbtModelInfo, excluded: readonly string[]): boolean {
  if (excluded.length === 0) return false;
  const set = new Set(excluded);
  return (
    set.has(model.uniqueId) ||
    set.has(model.name) ||
    set.has(model.path) ||
    set.has(model.originalFilePath)
  );
}

/**
 * "No reads for staleDays" — true when the model has never been read or its
 * last read is at least `staleDays` ago.
 */
export function isStaleByReads(analysis: ModelAnalysis, staleDays: number): boolean {
  return analysis.daysSinceRead === undefined || analysis.daysSinceRead >= staleDays;
}

/** Low usage — fewer than `lowReadCount` reads within the observation window. */
export function isLowReads(analysis: ModelAnalysis, lowReadCount: number): boolean {
  return analysis.readCount < lowReadCount;
}

/** No downstream dbt models and no exposures referencing the model. */
export function hasNoDownstream(analysis: ModelAnalysis): boolean {
  return (
    analysis.directDownstreamModels.length === 0 &&
    analysis.transitiveDownstreamModels.length === 0 &&
    analysis.exposures.length === 0 &&
    analysis.metrics.length === 0
  );
}
