/** Sampled kNN graph used as the always-on constellation web. */

export type WebEdge = {
  i: number;
  j: number;
  dist: number;
};

export function sampleIndices(count: number, max: number): number[] {
  const n = Math.min(count, max);
  if (n <= 0) return [];
  if (n === count) return Array.from({ length: count }, (_, i) => i);
  const stride = count / n;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    out[i] = Math.min(count - 1, Math.floor(i * stride + stride * 0.35));
  }
  return out;
}

export function knnEdges(
  positions: Float32Array,
  sample: number[],
  k: number,
  maxDist: number,
): WebEdge[] {
  const m = sample.length;
  if (m < 2) return [];
  const edges: WebEdge[] = [];
  const seen = new Set<string>();

  for (let a = 0; a < m; a++) {
    const ia = sample[a];
    const ax = positions[ia * 3];
    const ay = positions[ia * 3 + 1];
    const az = positions[ia * 3 + 2];
    const bestIdx = new Int32Array(k).fill(-1);
    const bestDist = new Float64Array(k).fill(Infinity);

    for (let b = 0; b < m; b++) {
      if (a === b) continue;
      const ib = sample[b];
      const dx = ax - positions[ib * 3];
      const dy = ay - positions[ib * 3 + 1];
      const dz = az - positions[ib * 3 + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d > maxDist || d === 0) continue;
      let slot = -1;
      for (let t = 0; t < k; t++) {
        if (d < bestDist[t]) {
          slot = t;
          break;
        }
      }
      if (slot < 0) continue;
      for (let t = k - 1; t > slot; t--) {
        bestDist[t] = bestDist[t - 1];
        bestIdx[t] = bestIdx[t - 1];
      }
      bestDist[slot] = d;
      bestIdx[slot] = ib;
    }

    for (let t = 0; t < k; t++) {
      const ib = bestIdx[t];
      if (ib < 0) continue;
      const lo = Math.min(ia, ib);
      const hi = Math.max(ia, ib);
      const key = `${lo}:${hi}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ i: lo, j: hi, dist: bestDist[t] });
    }
  }
  return edges;
}

export function buildConstellation(
  positions: Float32Array,
  count: number,
  extent: number,
): { hubs: Set<number>; edges: WebEdge[]; maxDist: number } {
  const fineMax = count > 120_000 ? 2400 : count > 40_000 ? 3000 : 3600;
  const coarseMax = Math.min(480, Math.max(80, Math.floor(count / 80)));
  const fine = sampleIndices(count, fineMax);
  const coarse = sampleIndices(count, coarseMax);
  const fineMaxDist = extent * 0.09;
  const coarseMaxDist = extent * 0.28;
  const edges = [
    ...knnEdges(positions, fine, 3, fineMaxDist),
    ...knnEdges(positions, coarse, 2, coarseMaxDist),
  ];
  return { hubs: new Set(fine), edges, maxDist: coarseMaxDist };
}
