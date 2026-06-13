/**
 * Kubernetes memory quantity helpers (Wave 2b).
 *
 * Parses/formats k8s memory quantities (`Mi`, `Gi`, `M`, `G`, plain bytes, plus
 * `Ki`/`Ti`/`K`/`T` for completeness) to/from a MiB number, and computes a
 * percentile over a usage sample array. Everything works in MiB internally so
 * the detector/recommender can reason in one unit.
 */

const BYTES_PER_MIB = 1024 * 1024;

/**
 * Multiplier (in bytes) for each supported quantity suffix. The empty suffix
 * means raw bytes. Binary suffixes are powers of 1024; decimal suffixes
 * (k/M/G/T) are powers of 1000, matching Kubernetes' resource.Quantity rules.
 */
const SUFFIX_TO_BYTES: Readonly<Record<string, number>> = {
  '': 1,
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  k: 1000,
  K: 1000,
  M: 1000 ** 2,
  G: 1000 ** 3,
  T: 1000 ** 4,
};

const QUANTITY_RE = /^\s*([0-9]+(?:\.[0-9]+)?)\s*([A-Za-z]*)\s*$/;

/** Parse a Kubernetes memory quantity string into a number of MiB. */
export function parseMemToMiB(quantity: string): number {
  const match = QUANTITY_RE.exec(quantity);
  if (match === null) {
    throw new Error(`invalid k8s memory quantity: ${JSON.stringify(quantity)}`);
  }
  const [, numStr, suffix = ''] = match;
  if (numStr === undefined) {
    throw new Error(`invalid k8s memory quantity: ${JSON.stringify(quantity)}`);
  }
  const factor = SUFFIX_TO_BYTES[suffix];
  if (factor === undefined) {
    throw new Error(`unsupported memory suffix ${JSON.stringify(suffix)} in ${quantity}`);
  }
  return (Number(numStr) * factor) / BYTES_PER_MIB;
}

/**
 * Format a MiB number back into a canonical Kubernetes quantity string.
 * Whole multiples of 1024 MiB render as `Gi`; everything else renders as a
 * rounded `Mi` value (the unit the agent reasons in).
 */
export function formatMiB(mib: number): string {
  const rounded = Math.round(mib);
  if (rounded > 0 && rounded % 1024 === 0) {
    return `${rounded / 1024}Gi`;
  }
  return `${rounded}Mi`;
}

/**
 * Linear-interpolation percentile (NumPy's default "R-7" method) over a sample
 * array. `p` is expressed as a percentage in [0, 100]. Returns 0 for an empty
 * array. Does not mutate the input.
 */
export function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0] ?? 0;
  const clampedP = Math.min(100, Math.max(0, p));
  const pos = (clampedP / 100) * (sorted.length - 1);
  const lowerIdx = Math.floor(pos);
  const upperIdx = Math.ceil(pos);
  const frac = pos - lowerIdx;
  const lower = sorted[lowerIdx] ?? 0;
  const upper = sorted[upperIdx] ?? lower;
  return lower + frac * (upper - lower);
}

/** Population standard deviation of a sample array (0 for < 2 samples). */
export function stdev(samples: number[]): number {
  if (samples.length < 2) return 0;
  const mean = samples.reduce((acc, v) => acc + v, 0) / samples.length;
  const variance =
    samples.reduce((acc, v) => acc + (v - mean) ** 2, 0) / samples.length;
  return Math.sqrt(variance);
}

/** Mean of a sample array (0 for an empty array). */
export function mean(samples: number[]): number {
  if (samples.length === 0) return 0;
  return samples.reduce((acc, v) => acc + v, 0) / samples.length;
}
