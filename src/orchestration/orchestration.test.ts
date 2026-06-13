/**
 * Wave 2c orchestration tests. Uses IN-TEST FAKES implementing the locked
 * pipeline interfaces — never the real dbt/k8s factories — and never opens a
 * real network connection (all runs are dry-run / mock).
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  Detector,
  Domain,
  FileChange,
  Finding,
  Recommendation,
  RunContext,
  SafetyAnalyzer,
  SafetyAssessment,
  Recommender,
} from '../contracts/index.js';
import { parseConfig } from '../contracts/index.js';
import { confidence, createLogger, stableId } from '../core/index.js';
import type { PipelineModules } from './index.js';
import {
  createGithubPrGenerator,
  createRunner,
  createStateStore,
} from './index.js';

// ---------------------------------------------------------------------------
// Fakes + helpers
// ---------------------------------------------------------------------------

const DBT_REF = 'model.shop.orders';

function silentCtx(patch: Record<string, unknown> = {}): RunContext {
  const config = parseConfig(patch);
  return {
    config,
    logger: createLogger({ level: 'error', sink: () => undefined }),
    now: () => new Date('2026-02-01T00:00:00.000Z'),
    dryRun: config.pr.dryRun,
    runId: 'run:test',
  };
}

function dbtFinding(ref = DBT_REF): Finding {
  return {
    id: stableId('dbt', ref),
    domain: 'dbt',
    targetRef: ref,
    title: `${ref} is stale`,
    severity: 'medium',
    signals: [
      {
        kind: 'snowflake-reads',
        summary: 'No reads in the last 120 days.',
        data: { reads: 0, windowDays: 120, owner: 'analytics-team' },
      },
      { kind: 'dbt-downstream', summary: 'No downstream models or exposures.' },
    ],
    detectedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
  };
}

const dbtChange: FileChange = {
  path: 'models/shop/orders.sql',
  kind: 'modify',
  description: 'Add deprecation config + doc warning.',
  patch: '--- a\n+++ b\n@@ deprecation @@',
};

function dbtRecommendation(opts: { score?: number; ref?: string } = {}): Recommendation {
  const ref = opts.ref ?? DBT_REF;
  const finding = dbtFinding(ref);
  const assessment: SafetyAssessment = {
    safe: true,
    confidence: confidence(opts.score ?? 0.9, 'stale + no downstream'),
    reasons: [{ kind: 'no-downstream', summary: 'No exposures, metrics, or downstream models.' }],
    blockers: [],
  };
  return {
    id: `rec:${finding.id}`,
    finding,
    assessment,
    action: {
      type: 'dbt-deprecate',
      model: ref,
      mode: 'flag-for-review',
      changes: [dbtChange],
    },
    estimatedImpact: {
      description: 'Removes idle daily materializations',
      metric: 'monthly-usd',
      estimatedValue: 42,
      unit: 'USD/month',
    },
    rollback: 'Revert the PR to remove the deprecation flag.',
  };
}

function k8sRecommendation(score = 0.9): Recommendation {
  const ref = 'deployment/prod/api';
  const finding: Finding = {
    id: stableId('k8s', ref),
    domain: 'kubernetes',
    targetRef: ref,
    title: 'api over-requests memory',
    signals: [{ kind: 'k8s-p95', summary: 'p95 = 600Mi vs request 1Gi.' }],
    detectedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
  };
  return {
    id: `rec:${finding.id}`,
    finding,
    assessment: {
      safe: true,
      confidence: confidence(score, 'no OOM in 14d'),
      reasons: [{ kind: 'no-oom', summary: 'No OOM kills in the lookback window.' }],
      blockers: [],
    },
    action: {
      type: 'k8s-memory-resize',
      workload: ref,
      container: 'api',
      currentRequest: '1Gi',
      proposedRequest: '768Mi',
      changes: [
        { path: 'fixtures/k8s/manifests/api.yaml', kind: 'modify', description: 'request 1Gi -> 768Mi' },
      ],
    },
    estimatedImpact: { description: 'Frees ~256Mi/replica', metric: 'memory-mib', estimatedValue: 256, unit: 'MiB' },
    rollback: 'Revert the PR to restore the 1Gi memory request.',
  };
}

function fakeDbtModules(): Pick<PipelineModules, 'detectors' | 'analyzers' | 'recommenders'> {
  const domain: Domain = 'dbt';
  const detector: Detector = {
    domain,
    detect: async () => [dbtFinding()],
  };
  const analyzer: SafetyAnalyzer = {
    domain,
    assess: async () => ({
      safe: true,
      confidence: confidence(0.9, 'stale + no downstream'),
      reasons: [{ kind: 'no-downstream', summary: 'No downstream dependents.' }],
      blockers: [],
    }),
  };
  const recommender: Recommender = {
    domain,
    recommend: async (finding, assessment) => ({
      id: `rec:${finding.id}`,
      finding,
      assessment,
      action: { type: 'dbt-deprecate', model: finding.targetRef, mode: 'flag-for-review', changes: [dbtChange] },
      estimatedImpact: { description: 'Removes idle daily materializations', estimatedValue: 42, unit: 'USD/month' },
      rollback: 'Revert the PR to remove the deprecation flag.',
    }),
  };
  return { detectors: [detector], analyzers: [analyzer], recommenders: [recommender] };
}

// ---------------------------------------------------------------------------
// StateStore
// ---------------------------------------------------------------------------

describe('StateStore', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-state-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips, upserts (preserve firstSeenAt / advance lastSeenAt), and transitions state', async () => {
    const store = createStateStore(dir);
    const id = stableId('dbt', DBT_REF);

    await store.record([
      {
        findingId: id,
        domain: 'dbt',
        targetRef: DBT_REF,
        state: 'detected',
        firstSeenAt: '2026-01-01T00:00:00.000Z',
        lastSeenAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    expect(await store.getKnown()).toHaveLength(1);

    // Re-record the same finding with a (wrong) later firstSeen + newer lastSeen.
    await store.record([
      {
        findingId: id,
        domain: 'dbt',
        targetRef: DBT_REF,
        state: 'detected',
        firstSeenAt: '2026-09-09T00:00:00.000Z',
        lastSeenAt: '2026-02-02T00:00:00.000Z',
      },
    ]);
    const got = await store.get(id);
    expect(got?.firstSeenAt).toBe('2026-01-01T00:00:00.000Z'); // preserved
    expect(got?.lastSeenAt).toBe('2026-02-02T00:00:00.000Z'); // advanced
    expect(await store.getKnown()).toHaveLength(1); // upsert, not duplicate

    await store.markState(id, 'proposed', 'opened draft');
    const after = await store.get(id);
    expect(after?.state).toBe('proposed');
    expect(after?.notes).toBe('opened draft');
  });
});

// ---------------------------------------------------------------------------
// PR generator
// ---------------------------------------------------------------------------

describe('GitHub PR generator', () => {
  it('honors dryRun, filters low confidence, and embeds impact + rollback', async () => {
    const ctx = silentCtx({ pr: { dryRun: true, minConfidenceToOpen: 0.8, maxPrsPerRun: 5 } });
    const generator = createGithubPrGenerator();

    const high = dbtRecommendation({ score: 0.9, ref: 'model.shop.orders' });
    const low = dbtRecommendation({ score: 0.2, ref: 'model.shop.legacy' });

    const results = await generator.generate([high, low], ctx);

    expect(results).toHaveLength(1);
    expect(results[0]?.dryRun).toBe(true);
    expect(results[0]?.opened).toBe(false);
    expect(results[0]?.url).toBeUndefined();
    expect(results[0]?.draft.sourceRecommendationIds).toContain(high.id);
    expect(results[0]?.draft.sourceRecommendationIds).not.toContain(low.id);

    const body = (results[0]?.draft.body ?? '').toLowerCase();
    expect(body).toContain('rollback');
    expect(body).toContain('impact');
    expect(body).toContain('estimated impact');
  });

  it('caps the number of PRs at maxPrsPerRun across domains', async () => {
    const ctx = silentCtx({
      enabledDomains: ['dbt', 'kubernetes'],
      pr: { dryRun: true, minConfidenceToOpen: 0.5, maxPrsPerRun: 1 },
    });
    const generator = createGithubPrGenerator();

    const results = await generator.generate(
      [dbtRecommendation({ score: 0.9 }), k8sRecommendation(0.9)],
      ctx,
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.dryRun).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Runner (end-to-end with fakes + real state store + real PR generator)
// ---------------------------------------------------------------------------

describe('Runner end-to-end (dry-run)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-run-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('detects → recommends → drafts PR (dry-run) and marks the finding proposed', async () => {
    const ctx = silentCtx({
      enabledDomains: ['dbt'],
      pr: { dryRun: true, minConfidenceToOpen: 0.8, maxPrsPerRun: 5 },
    });
    const modules: PipelineModules = {
      ...fakeDbtModules(),
      prGenerator: createGithubPrGenerator(),
    };
    const store = createStateStore(dir);

    const report = await createRunner(ctx, modules, store).run();

    expect(report.dryRun).toBe(true);
    expect(report.stats.dbt?.detected).toBeGreaterThanOrEqual(1);
    expect(report.stats.dbt?.recommended).toBeGreaterThanOrEqual(1);
    expect(report.prResults.length).toBeGreaterThanOrEqual(1);
    expect(report.prResults[0]?.dryRun).toBe(true);
    expect(report.prResults[0]?.opened).toBe(false);

    const known = await store.get(stableId('dbt', DBT_REF));
    expect(known?.state).toBe('proposed');
    expect(known?.prDraftId).toBe(report.prResults[0]?.draft.id);
  });
});
