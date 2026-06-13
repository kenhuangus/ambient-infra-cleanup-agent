import { describe, expect, it } from 'vitest';

import {
  parseConfig,
  type Finding,
  type RunContext,
  type SafetyAssessment,
} from '../contracts/index.js';
import { confidence, createLogger, stableId } from '../core/index.js';
import { readContainerMemory } from './connectors/manifests.js';
import { createK8sModule } from './index.js';
import { K8sMemoryRecommender } from './recommender.js';
import { parseMemToMiB } from './units.js';

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

const safeAssessment: SafetyAssessment = {
  safe: true,
  confidence: confidence(0.9),
  reasons: [],
  blockers: [],
};

const unsafeAssessment: SafetyAssessment = {
  safe: false,
  confidence: confidence(0.2),
  reasons: [],
  blockers: ['recent OOM kill'],
};

describe('K8sMemoryRecommender', () => {
  it('produces a k8s-memory-resize recommendation for api', async () => {
    const ctx = makeCtx();
    const rec = await new K8sMemoryRecommender().recommend(
      findingFor('deployment/prod/api', 'api'),
      safeAssessment,
      ctx,
    );

    expect(rec).not.toBeNull();
    if (rec === null) return;

    expect(rec.action.type).toBe('k8s-memory-resize');
    if (rec.action.type !== 'k8s-memory-resize') return;

    expect(rec.action.workload).toBe('deployment/prod/api');
    expect(rec.action.container).toBe('api');
    expect(rec.action.currentRequest).toBe('1Gi');

    // proposed request must be strictly smaller than current
    const proposedMiB = parseMemToMiB(rec.action.proposedRequest);
    const currentMiB = parseMemToMiB(rec.action.currentRequest);
    expect(proposedMiB).toBeLessThan(currentMiB);

    // requests-only for MVP: no limit changes
    expect(rec.action.proposedLimit).toBeUndefined();

    // a single manifest modify whose new content carries the new value
    expect(rec.action.changes).toHaveLength(1);
    const change = rec.action.changes[0];
    expect(change?.kind).toBe('modify');
    expect(change?.path).toBe('fixtures/k8s/manifests/api.yaml');
    expect(change?.newContent).toContain(rec.action.proposedRequest);

    // parse the edited YAML: request lowered, limit left untouched (requests-only)
    const edited = readContainerMemory(change?.newContent ?? '', 'api');
    expect(edited.request).toBe(rec.action.proposedRequest);
    expect(edited.limit).toBe('1Gi');

    // impact + rollback
    expect(rec.estimatedImpact?.metric).toBe('memory-mib');
    expect(rec.estimatedImpact?.unit).toBe('MiB');
    expect((rec.estimatedImpact?.estimatedValue ?? 0)).toBeGreaterThan(0);
    expect(rec.rollback.length).toBeGreaterThan(0);
    expect(rec.rollback).toContain('1Gi');
  });

  it('returns null for an unsafe (blocked) workload', async () => {
    const ctx = makeCtx();
    const rec = await new K8sMemoryRecommender().recommend(
      findingFor('deployment/prod/worker', 'worker'),
      unsafeAssessment,
      ctx,
    );
    expect(rec).toBeNull();
  });

  it('returns null when savings fall below the threshold (cache)', async () => {
    const ctx = makeCtx();
    const rec = await new K8sMemoryRecommender().recommend(
      findingFor('deployment/prod/cache', 'cache'),
      safeAssessment,
      ctx,
    );
    expect(rec).toBeNull();
  });

  it('end-to-end via the factory: exactly one resize for api', async () => {
    const ctx = makeCtx();
    const { detector, analyzer, recommender } = createK8sModule();
    expect(detector.domain).toBe('kubernetes');
    expect(analyzer.domain).toBe('kubernetes');
    expect(recommender.domain).toBe('kubernetes');

    const findings = await detector.detect(ctx);
    const recs = [];
    for (const f of findings) {
      const assessment = await analyzer.assess(f, ctx);
      const rec = await recommender.recommend(f, assessment, ctx);
      if (rec !== null) recs.push(rec);
    }

    expect(recs).toHaveLength(1);
    expect(recs[0]?.finding.targetRef).toBe('deployment/prod/api');
  });
});
