import { describe, expect, it } from 'vitest';

import {
  defaultConfig,
  parseConfig,
  validateConfig,
  type AgentConfig,
  type Recommendation,
} from '../src/contracts/index.js';
import {
  clamp01,
  confidence,
  createLogger,
  levelFromScore,
  ok,
  stableId,
} from '../src/core/index.js';
import { createDbtModule } from '../src/dbt/index.js';
import { createK8sModule } from '../src/k8s/index.js';
import { createRunner } from '../src/orchestration/index.js';

describe('contracts surface', () => {
  it('exports a valid defaultConfig', () => {
    expect(defaultConfig.pr.dryRun).toBe(true);
    expect(defaultConfig.enabledDomains).toContain('dbt');
    expect(defaultConfig.enabledDomains).toContain('kubernetes');
    // defaultConfig must pass its own validation.
    expect(() => validateConfig(defaultConfig)).not.toThrow();
  });

  it('parseConfig merges overrides with defaults', () => {
    const cfg: AgentConfig = parseConfig({ pr: { maxPrsPerRun: 2 } });
    expect(cfg.pr.maxPrsPerRun).toBe(2);
    // untouched keys fall back to defaults
    expect(cfg.pr.dryRun).toBe(defaultConfig.pr.dryRun);
    expect(cfg.dbt.staleDays).toBe(defaultConfig.dbt.staleDays);
  });

  it('parseConfig rejects out-of-range values', () => {
    expect(() => parseConfig({ pr: { minConfidenceToOpen: 2 } })).toThrow();
  });
});

describe('core utilities', () => {
  it('clamps and levels confidence scores', () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(levelFromScore(0.9)).toBe('high');
    expect(levelFromScore(0.6)).toBe('medium');
    expect(levelFromScore(0.1)).toBe('low');
    const c = confidence(0.85, 'strong evidence');
    expect(c.level).toBe('high');
    expect(c.score).toBeCloseTo(0.85);
    expect(c.rationale).toBe('strong evidence');
  });

  it('produces stable ids', () => {
    expect(stableId('dbt', 'model.shop.orders')).toBe(
      stableId('dbt', 'model.shop.orders'),
    );
    expect(stableId('dbt', 'a')).not.toBe(stableId('dbt', 'b'));
  });

  it('logger respects level filtering', () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: 'warn',
      sink: (_level, line) => lines.push(line),
    });
    logger.info('should be filtered');
    logger.error('should appear');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('should appear');
  });

  it('Result helpers work', () => {
    const r = ok(42);
    expect(r.ok).toBe(true);
    expect(r.value).toBe(42);
  });
});

describe('Wave 2 factories are implemented and wired', () => {
  it('domain factories return modules with the locked pipeline shape', () => {
    expect(createDbtModule).toBeTypeOf('function');
    expect(createK8sModule).toBeTypeOf('function');
    expect(createRunner).toBeTypeOf('function');

    const dbt = createDbtModule();
    expect(dbt.detector.domain).toBe('dbt');
    expect(dbt.analyzer.domain).toBe('dbt');
    expect(dbt.recommender.domain).toBe('dbt');

    const k8s = createK8sModule();
    expect(k8s.detector.domain).toBe('kubernetes');
    expect(k8s.analyzer.domain).toBe('kubernetes');
    expect(k8s.recommender.domain).toBe('kubernetes');
  });
});

describe('discriminated union typechecks', () => {
  it('narrows RecommendationAction by type (compile + runtime)', () => {
    // This object is shaped purely from the locked contract types.
    const rec: Recommendation = {
      id: 'rec:1',
      finding: {
        id: stableId('k8s', 'deployment/prod/api'),
        domain: 'kubernetes',
        targetRef: 'deployment/prod/api',
        title: 'api over-requests memory',
        signals: [{ kind: 'k8s-p95', summary: 'p95 = 600Mi vs request 1Gi' }],
        detectedAt: new Date(0).toISOString(),
      },
      assessment: {
        safe: true,
        confidence: confidence(0.9),
        reasons: [{ kind: 'no-oom', summary: 'no OOM in 14d' }],
        blockers: [],
      },
      action: {
        type: 'k8s-memory-resize',
        workload: 'deployment/prod/api',
        container: 'api',
        currentRequest: '1Gi',
        proposedRequest: '768Mi',
        changes: [
          {
            path: 'fixtures/k8s/manifests/api.yaml',
            kind: 'modify',
            description: 'lower memory request to 768Mi',
          },
        ],
      },
      rollback: 'Revert the PR to restore the 1Gi request.',
    };

    expect(rec.action.type).toBe('k8s-memory-resize');
    if (rec.action.type === 'k8s-memory-resize') {
      expect(rec.action.proposedRequest).toBe('768Mi');
    }
  });
});
