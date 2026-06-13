/**
 * Combined dbt data loader. Loads the artifacts + Snowflake usage connectors
 * once per (artifactDir, snowflake) configuration and memoizes the result so
 * the detector, analyzer, and recommender stages share a single read.
 */

import type { RunContext } from '../../contracts/index.js';
import { loadDbtArtifacts, type DbtArtifacts } from './dbtArtifacts.js';
import { loadSnowflakeUsage, type SnowflakeUsage } from './snowflakeUsage.js';

export interface DbtData {
  artifacts: DbtArtifacts;
  usage: SnowflakeUsage;
}

const cache = new Map<string, Promise<DbtData>>();

function cacheKey(ctx: RunContext): string {
  const dbt = ctx.config.connectors.dbt;
  return [dbt.artifactDir, dbt.snowflake.mode, dbt.snowflake.mockPath ?? ''].join('|');
}

export function loadDbtData(ctx: RunContext): Promise<DbtData> {
  const key = cacheKey(ctx);
  const existing = cache.get(key);
  if (existing !== undefined) return existing;

  const dbt = ctx.config.connectors.dbt;
  const loaded = (async (): Promise<DbtData> => {
    const [artifacts, usage] = await Promise.all([
      loadDbtArtifacts(dbt.artifactDir, ctx.logger),
      loadSnowflakeUsage(dbt.snowflake, ctx.logger),
    ]);
    return { artifacts, usage };
  })();

  cache.set(key, loaded);
  return loaded;
}

export type { DbtArtifacts, DbtModelInfo, DbtExposureInfo } from './dbtArtifacts.js';
export type { SnowflakeUsage, SnowflakeUsageRecord } from './snowflakeUsage.js';
