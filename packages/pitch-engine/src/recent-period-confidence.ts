function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

// A live MediaStream can pad one short scheduling hole across two 128-sample
// Web Audio render quanta. Longer exact-zero tails are current silence.
const MAX_EXACT_ZERO_EDGE_PADDING_SAMPLES = 256;

/**
 * Measure whether a selected period is still present at the observation's
 * current edge. Two equally shaped periods score the same at any nonzero
 * scale. A bounded exact-zero transport suffix is ignored, while a longer
 * zero tail or a zero/one-period remnant cannot masquerade as current pitch.
 */
export function recentPeriodConfidence(
  samples: Float32Array,
  selectedTau: number,
  currentEdgeSpanSamples = 0,
): number {
  const period = Math.max(1, Math.round(selectedTau));
  let currentEnd = samples.length;
  if (currentEdgeSpanSamples > 0) {
    let exactZeroPadding = 0;
    while (currentEnd > 0 && samples[currentEnd - 1] === 0) {
      exactZeroPadding += 1;
      if (exactZeroPadding > MAX_EXACT_ZERO_EDGE_PADDING_SAMPLES) return 0;
      currentEnd -= 1;
    }
  }
  const currentStart = currentEdgeSpanSamples > 0
    ? Math.max(period, samples.length - currentEdgeSpanSamples)
    : currentEnd - period;
  if (currentStart < period || currentStart >= currentEnd) return 0;
  let squaredDifference = 0;
  let combinedEnergy = 0;
  for (let index = currentStart; index < currentEnd; index += 1) {
    const previous = samples[index - period]!;
    const current = samples[index]!;
    const delta = previous - current;
    squaredDifference += delta * delta;
    combinedEnergy += previous * previous + current * current;
  }
  if (combinedEnergy === 0) return 0;
  return clampUnit(1 - squaredDifference / combinedEnergy);
}
