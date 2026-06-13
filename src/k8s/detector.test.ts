import { describe, expect, it } from 'vitest';

import { parseConfig, type RunContext } from '../contracts/index.js';
import { createLogger } from '../core/index.js';
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

describe('K8sDetector', () => {
  it('flags overprovisioned prod workloads (api + worker), skips the rest', async () => {
    const findings = await new K8sDetector().detect(makeCtx());
    const refs = findings.map((f) => f.targetRef).sort();

    expect(refs).toEqual(['deployment/prod/api', 'deployment/prod/worker']);
    // excluded namespace is never flagged
    expect(refs).not.toContain('deployment/dev/scratch');
    // right-sized workload (savings below threshold) is not flagged
    expect(refs).not.toContain('deployment/prod/cache');
    // too-few-samples workload is not flagged
    expect(refs).not.toContain('deployment/prod/tiny');
  });

  it('attaches utilization + savings evidence with a stable id', async () => {
    const findings = await new K8sDetector().detect(makeCtx());
    const api = findings.find((f) => f.targetRef === 'deployment/prod/api');
    expect(api).toBeDefined();
    expect(api?.domain).toBe('kubernetes');
    expect(api?.id.startsWith('k8s:')).toBe(true);
    const kinds = api?.signals.map((s) => s.kind) ?? [];
    expect(kinds).toContain('k8s-utilization');
    expect(kinds).toContain('k8s-savings');
  });

  it('flags nothing when prod is also excluded', async () => {
    const findings = await new K8sDetector().detect(
      makeCtx({ excludedNamespaces: ['dev', 'prod'] }),
    );
    expect(findings).toHaveLength(0);
  });
});
