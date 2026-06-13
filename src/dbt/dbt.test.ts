import { describe, expect, it } from 'vitest';

import {
  parseConfig,
  type Finding,
  type RunContext,
} from '../contracts/index.js';
import { createLogger } from '../core/index.js';
import { createDbtModule } from './index.js';
import { loadSnowflakeUsage } from './connectors/snowflakeUsage.js';

const STALE = 'model.shop.stale_orders_snapshot';
const LEGACY = 'model.shop.legacy_revenue';
const ACTIVE = 'model.shop.daily_active_users';
const EXCLUDED = 'model.shop.experimental_temp';

/** A deterministic RunContext pointed at the dbt fixtures. */
function makeCtx(): RunContext {
  const config = parseConfig({
    excludedDbtModels: [EXCLUDED],
    connectors: {
      dbt: {
        mode: 'mock',
        artifactDir: 'fixtures/dbt',
        snowflake: { mode: 'mock', mockPath: 'fixtures/dbt/snowflake_usage.json' },
      },
    },
  });
  return {
    config,
    logger: createLogger({ level: 'error' }),
    now: () => new Date('2026-06-13T00:00:00Z'),
    dryRun: config.pr.dryRun,
    runId: 'test-run',
  };
}

async function detectFindings(): Promise<Finding[]> {
  const ctx = makeCtx();
  return createDbtModule().detector.detect(ctx);
}

function byRef(findings: Finding[], targetRef: string): Finding {
  const found = findings.find((f) => f.targetRef === targetRef);
  if (found === undefined) throw new Error(`expected a finding for ${targetRef}`);
  return found;
}

describe('DbtDetector', () => {
  it('flags exactly the stale + legacy candidates (not active or excluded)', async () => {
    const findings = await detectFindings();
    const refs = findings.map((f) => f.targetRef).sort();

    expect(refs).toEqual([LEGACY, STALE]);
    expect(refs).not.toContain(ACTIVE);
    expect(refs).not.toContain(EXCLUDED);
  });

  it('emits rich, stable evidence for the stale orphan', async () => {
    const findings = await detectFindings();
    const stale = byRef(findings, STALE);

    expect(stale.id).toBe(byRef(await detectFindings(), STALE).id); // stable across runs
    expect(stale.severity).toBe('high');
    expect(stale.signals.length).toBeGreaterThanOrEqual(3);
    expect(stale.signals.map((s) => s.kind)).toContain('snowflake-usage');
    expect(stale.signals.map((s) => s.kind)).toContain('dbt-lineage');
  });
});

describe('DbtSafetyAnalyzer', () => {
  it('marks the orphaned stale model safe with no blockers', async () => {
    const ctx = makeCtx();
    const { analyzer } = createDbtModule();
    const stale = byRef(await detectFindings(), STALE);

    const assessment = await analyzer.assess(stale, ctx);
    expect(assessment.safe).toBe(true);
    expect(assessment.blockers).toHaveLength(0);
    expect(assessment.confidence.level).toBe('high');
    expect(assessment.confidence.score).toBeGreaterThanOrEqual(0.8);
  });

  it('marks the legacy model unsafe with a downstream blocker', async () => {
    const ctx = makeCtx();
    const { analyzer } = createDbtModule();
    const legacy = byRef(await detectFindings(), LEGACY);

    const assessment = await analyzer.assess(legacy, ctx);
    expect(assessment.safe).toBe(false);
    expect(assessment.blockers.length).toBeGreaterThanOrEqual(1);
    expect(assessment.blockers.join(' ')).toMatch(/downstream/i);
  });
});

describe('DbtRecommender', () => {
  it('recommends mode "deprecate" for the safe orphan with a file change + rollback', async () => {
    const ctx = makeCtx();
    const { analyzer, recommender } = createDbtModule();
    const stale = byRef(await detectFindings(), STALE);
    const assessment = await analyzer.assess(stale, ctx);

    const rec = await recommender.recommend(stale, assessment, ctx);
    expect(rec).not.toBeNull();
    if (rec === null) return;

    expect(rec.action.type).toBe('dbt-deprecate');
    if (rec.action.type !== 'dbt-deprecate') return;
    expect(rec.action.mode).toBe('deprecate');
    expect(rec.action.model).toBe(STALE);
    expect(rec.action.changes.length).toBeGreaterThanOrEqual(1);
    expect(rec.action.changes[0]?.kind).toBe('modify');
    expect(rec.rollback.length).toBeGreaterThan(0);
    expect(rec.estimatedImpact?.metric).toBe('monthly-usd');
    expect(rec.estimatedImpact?.unit).toBe('USD/month');
  });

  it('recommends mode "flag-for-review" for the legacy model with dependents', async () => {
    const ctx = makeCtx();
    const { analyzer, recommender } = createDbtModule();
    const legacy = byRef(await detectFindings(), LEGACY);
    const assessment = await analyzer.assess(legacy, ctx);

    const rec = await recommender.recommend(legacy, assessment, ctx);
    expect(rec).not.toBeNull();
    if (rec === null) return;

    expect(rec.action.type).toBe('dbt-deprecate');
    if (rec.action.type !== 'dbt-deprecate') return;
    expect(rec.action.mode).toBe('flag-for-review');
    expect(rec.action.changes.length).toBeGreaterThanOrEqual(1);
    expect(rec.rollback.length).toBeGreaterThan(0);
  });
});

describe('snowflakeUsage connector', () => {
  it('throws a descriptive error in live mode (MVP is mock-only)', async () => {
    const logger = createLogger({ level: 'error' });
    await expect(
      loadSnowflakeUsage({ mode: 'live', account: 'acme', database: 'ANALYTICS' }, logger),
    ).rejects.toThrow(/live mode not implemented/i);
  });
});
