import { describe, expect, it } from 'vitest';

import { formatMiB, mean, parseMemToMiB, percentile, stdev } from './units.js';

describe('k8s memory units', () => {
  it('parses binary, decimal, and byte quantities to MiB', () => {
    expect(parseMemToMiB('1Gi')).toBe(1024);
    expect(parseMemToMiB('640Mi')).toBe(640);
    expect(parseMemToMiB('512Mi')).toBe(512);
    // decimal suffixes are 1000-based
    expect(parseMemToMiB('1G')).toBeCloseTo(1_000_000_000 / (1024 * 1024));
    expect(parseMemToMiB('100M')).toBeCloseTo(100_000_000 / (1024 * 1024));
    // plain bytes
    expect(parseMemToMiB(String(2 * 1024 * 1024))).toBe(2);
  });

  it('formats MiB back into canonical quantities', () => {
    expect(formatMiB(1024)).toBe('1Gi');
    expect(formatMiB(2048)).toBe('2Gi');
    expect(formatMiB(640)).toBe('640Mi');
    expect(formatMiB(689.3)).toBe('689Mi');
  });

  it('round-trips quantities through parse/format', () => {
    for (const q of ['1Gi', '2Gi', '640Mi', '512Mi', '256Mi']) {
      expect(formatMiB(parseMemToMiB(q))).toBe(q);
    }
  });

  it('rejects malformed quantities', () => {
    expect(() => parseMemToMiB('not-a-size')).toThrow();
    expect(() => parseMemToMiB('10Zi')).toThrow();
  });

  it('computes percentiles via linear interpolation', () => {
    const samples = [10, 20, 30, 40, 50];
    expect(percentile(samples, 50)).toBe(30);
    expect(percentile(samples, 0)).toBe(10);
    expect(percentile(samples, 100)).toBe(50);
    // pos = 0.95 * 4 = 3.8 -> 40 + 0.8 * (50 - 40) = 48
    expect(percentile(samples, 95)).toBeCloseTo(48);
    // order independence
    expect(percentile([50, 10, 30, 20, 40], 50)).toBe(30);
    // empty array is safe
    expect(percentile([], 95)).toBe(0);
  });

  it('computes mean and stdev', () => {
    expect(mean([2, 4, 6])).toBe(4);
    expect(stdev([4, 4, 4])).toBe(0);
    expect(stdev([2, 4, 6])).toBeCloseTo(Math.sqrt(8 / 3));
  });
});
