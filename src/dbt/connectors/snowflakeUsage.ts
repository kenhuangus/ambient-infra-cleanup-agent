/**
 * Snowflake usage connector (read-only).
 *
 * `mock` mode reads a JSON map from `config.connectors.dbt.snowflake.mockPath`
 * keyed by model relation / unique_id -> usage record. `live` mode is not part
 * of the recommend-only MVP and throws a descriptive error.
 */

import { readFile } from 'node:fs/promises';

import type { DbtConnectorConfig, Logger } from '../../contracts/index.js';
import { asDate, asNumber, asRecord, asString } from './json.js';

export interface SnowflakeUsageRecord {
  /** ISO-8601 timestamp of the most recent read, if ever read. */
  lastReadAt?: string;
  /** Number of reads observed within `windowDays`. */
  readCount: number;
  /** Length of the observation window in days. */
  windowDays: number;
  /** Approximate monthly warehouse compute cost attributable to the model. */
  monthlyComputeUsd?: number;
}

export interface SnowflakeUsage {
  /** Resolve usage by any of the provided keys (unique_id, relation, ...). */
  get(...keys: Array<string | undefined>): SnowflakeUsageRecord | undefined;
  /** Most recent read time across keys, parsed to a Date. */
  lastReadAt(...keys: Array<string | undefined>): Date | undefined;
}

function parseRecord(raw: unknown): SnowflakeUsageRecord | undefined {
  const record = asRecord(raw);
  const readCount = asNumber(record['readCount']);
  const windowDays = asNumber(record['windowDays']);
  if (readCount === undefined || windowDays === undefined) return undefined;
  const lastReadAt = asString(record['lastReadAt']);
  const monthlyComputeUsd = asNumber(record['monthlyComputeUsd']);
  return {
    ...(lastReadAt === undefined ? {} : { lastReadAt }),
    readCount,
    windowDays,
    ...(monthlyComputeUsd === undefined ? {} : { monthlyComputeUsd }),
  };
}

type SnowflakeConfig = DbtConnectorConfig['snowflake'];

export async function loadSnowflakeUsage(
  config: SnowflakeConfig,
  logger: Logger,
): Promise<SnowflakeUsage> {
  if (config.mode === 'live') {
    throw new Error('Snowflake live mode not implemented in MVP — use mock');
  }

  const byKey = new Map<string, SnowflakeUsageRecord>();
  const mockPath = config.mockPath;
  if (mockPath === undefined) {
    logger.warn('snowflake mock mode but no mockPath configured; no usage data');
  } else {
    try {
      const text = await readFile(mockPath, 'utf8');
      const parsed = asRecord(JSON.parse(text) as unknown);
      for (const [key, value] of Object.entries(parsed)) {
        const record = parseRecord(value);
        if (record !== undefined) byKey.set(key, record);
      }
    } catch {
      logger.warn('snowflake usage mock file not found or unreadable', { mockPath });
    }
  }

  function resolve(keys: Array<string | undefined>): SnowflakeUsageRecord | undefined {
    for (const key of keys) {
      if (key === undefined) continue;
      const hit = byKey.get(key);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }

  return {
    get: (...keys) => resolve(keys),
    lastReadAt: (...keys) => asDate(resolve(keys)?.lastReadAt),
  };
}
