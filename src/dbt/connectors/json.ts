/**
 * Tiny JSON narrowing helpers. dbt/Snowflake artifacts are large, partially
 * documented, and version-drifty, so we parse them as `unknown` and narrow
 * defensively here instead of using `any`.
 */

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asStringArray(value: unknown): string[] {
  return asArray(value).filter((item): item is string => typeof item === 'string');
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** Parse an ISO-8601 string into a Date, returning undefined on bad input. */
export function asDate(value: unknown): Date | undefined {
  const text = asString(value);
  if (text === undefined) return undefined;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? undefined : new Date(ms);
}
