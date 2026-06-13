import { describe, expect, it } from 'vitest';

import { parseConfig, type Finding, type RunContext } from '../contracts/index.js';
import { createLogger, stableId } from '../core/index.js';
import { K8sSafetyAnalyzer } from './analyzer.js';
import { K8sDetector } from './detector.js';

function makeCtx(overrides: Record<string, unknown> = {}): RunContext {
  const config = parseConfig({
    excludedNamespaces: ['dev'],
    connectors: {
      k8s: {
        metrics: { mode: 'mock', mockPath: 'fixtures/k8s/metrics.json' },
        manifestsDir: 'fixtures/k8s/manifests',
      },
    },
    ...overrides,
  });
  return {
    config,
    logger: createLogger({ level: 'error' }),
    now: () => new Date('2026-06-13T00:00:00Z'),
    dryRun: config.pr.dryRun,
    runId: 'test-run',
  };
}

function findingFor(targetRef: string, container: string): Finding {
  return {
    id: stableId('k8s', targetRef, container),
    domain: 'kubernetes',
    targetRef,
    title: `test finding for ${targetRef}`,
    signals: [],
    detectedAt: '2026-06-13T00:00:00Z',
  };
}

describe('K8sSafetyAnalyzer', () => {
  it('marks the healthy api workload safe with confident scoring', async () => {
    const ctx = makeCtx();
    const assessment = await new K8sSafetyAnalyzer().assess(
      findingFor('deployment/prod/api', 'api'),
      ctx,
    );
    expect(assessment.safe).toBe(true);
    expect(assessment.blockers).toHaveLength(0);
    expect(assessment.confidence.score).toBeGreaterThan(0.5);
    expect(assessment.reasons.length).toBeGreaterThan(0);
  });

  it('blocks the worker with recent OOM and high restarts', async () => {
    const ctx = makeCtx();
    const assessment = await new K8sSafetyAnalyzer().assess(
      findingFor('deployment/prod/worker', 'worker'),
      ctx,
    );
    expect(assessment.safe).toBe(false);
    expect(assessment.blockers.length).toBeGreaterThan(0);
    const joined = assessment.blockers.join(' | ');
    expect(joined).toMatch(/OOM/i);
    expect(joined).toMatch(/restart/i);
    // unsafe assessments must never report high confidence in safety
    expect(assessment.confidence.score).toBeLessThanOrEqual(0.3);
  });

  it('blocks workloads with insufficient samples', async () => {
    const ctx = makeCtx();
    const assessment = await new K8sSafetyAnalyzer().assess(
      findingFor('deployment/prod/tiny', 'tiny'),
      ctx,
    );
    expect(assessment.safe).toBe(false);
    expect(assessment.blockers.join(' | ')).toMatch(/insufficient samples/i);
  });

  it('integrates with the detector: api safe, worker blocked', async () => {
    const ctx = makeCtx();
    const analyzer = new K8sSafetyAnalyzer();
    const findings = await new K8sDetector().detect(ctx);
    const results = await Promise.all(
      findings.map(async (f) => ({
        ref: f.targetRef,
        safe: (await analyzer.assess(f, ctx)).safe,
      })),
    );
    const byRef = Object.fromEntries(results.map((r) => [r.ref, r.safe]));
    expect(byRef['deployment/prod/api']).toBe(true);
    expect(byRef['deployment/prod/worker']).toBe(false);
  });
});
