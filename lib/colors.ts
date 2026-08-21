// Categorical palette (oklch hue wheel) for cluster coloring, plus a
// fallback gradient for non-clustered data.

const PALETTE_SIZE = 16;

function oklchToRgb(l: number, c: number, h: number): [number, number, number] {
  const hr = (h * Math.PI) / 180;
  const a = c * Math.cos(hr);
  const b = c * Math.sin(hr);

  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;

  const l3 = l_ ** 3;
  const m3 = m_ ** 3;
  const s3 = s_ ** 3;

  const r = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
  const g = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
  const b_ = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3;

  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const toSrgb = (v: number) =>
    v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;

  return [
    Math.round(clamp(toSrgb(r)) * 255),
    Math.round(clamp(toSrgb(g)) * 255),
    Math.round(clamp(toSrgb(b_)) * 255),
  ];
}

export const CLUSTER_PALETTE: [number, number, number][] = Array.from(
  { length: PALETTE_SIZE },
  (_, i) => oklchToRgb(0.72, 0.19, (i * 360) / PALETTE_SIZE),
);

export const UNCLUSTERED_COLOR: [number, number, number] = [56, 189, 248];

export type ClusterColorMap = Record<string, [number, number, number]>;

/** Base-2 van der Corput: 0, 0.5, 0.25, 0.75, 0.125… so nearby ranks sit far apart on the wheel. */
function vanDerCorput2(n: number): number {
  let inv = 0;
  let denom = 1;
  while (n > 0) {
    denom *= 2;
    inv += (n % 2) / denom;
    n = Math.floor(n / 2);
  }
  return inv;
}

function colorForSizeRank(rank: number): [number, number, number] {
  const hue = vanDerCorput2(rank) * 360;
  const light = 0.74 + (rank % 2 === 0 ? 0.05 : -0.05);
  const chroma = rank < 8 ? 0.22 : 0.16;
  return oklchToRgb(light, chroma, hue);
}

/** Color map keyed by cluster id. Largest clusters get the most separated hues. */
export function buildClusterColors(
  clusters: ArrayLike<number>,
  count: number,
): ClusterColorMap {
  const counts = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    const id = clusters[i];
    if (id < 0) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const colors: ClusterColorMap = {};
  for (let i = 0; i < ranked.length; i++) {
    colors[String(ranked[i][0])] = colorForSizeRank(i);
  }
  return colors;
}

export function clusterColor(
  cluster: number,
  colors?: ClusterColorMap,
): [number, number, number] {
  if (cluster < 0) return UNCLUSTERED_COLOR;
  return colors?.[String(cluster)] ?? CLUSTER_PALETTE[cluster % PALETTE_SIZE];
}

export function clusterRgbCss(
  cluster: number,
  colors?: ClusterColorMap,
): string {
  const [r, g, b] = clusterColor(cluster, colors);
  return `rgb(${r} ${g} ${b})`;
}

export function clusterLabel(
  cluster: number,
  labels?: Record<string, string>,
): string {
  if (cluster < 0) return "Unclustered";
  return labels?.[String(cluster)] ?? String(cluster);
}
