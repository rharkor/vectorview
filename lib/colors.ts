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

export function clusterColor(cluster: number): [number, number, number] {
  if (cluster < 0) return UNCLUSTERED_COLOR;
  return CLUSTER_PALETTE[cluster % PALETTE_SIZE];
}
