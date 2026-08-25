/** Uniform grid over projected coordinates for fast local neighbor queries. */

export type GridIndex = {
  cell: number;
  bins: Map<string, number[]>;
  positions: Float32Array;
  count: number;
};

export function buildGrid(positions: Float32Array, count: number, cell: number): GridIndex {
  const bins = new Map<string, number[]>();
  const size = Math.max(cell, 1e-9);
  for (let i = 0; i < count; i++) {
    const key = cellKey(
      Math.floor(positions[i * 3] / size),
      Math.floor(positions[i * 3 + 1] / size),
    );
    const bin = bins.get(key);
    if (bin) bin.push(i);
    else bins.set(key, [i]);
  }
  return { cell: size, bins, positions, count };
}

export function queryRadius(
  index: GridIndex,
  x: number,
  y: number,
  z: number,
  radius: number,
): { idx: number; dist: number }[] {
  const { cell, bins, positions } = index;
  const r2 = radius * radius;
  const i0 = Math.floor((x - radius) / cell);
  const i1 = Math.floor((x + radius) / cell);
  const j0 = Math.floor((y - radius) / cell);
  const j1 = Math.floor((y + radius) / cell);
  const hits: { idx: number; dist: number }[] = [];
  for (let ix = i0; ix <= i1; ix++) {
    for (let iy = j0; iy <= j1; iy++) {
      const bin = bins.get(cellKey(ix, iy));
      if (!bin) continue;
      for (const idx of bin) {
        const dx = positions[idx * 3] - x;
        const dy = positions[idx * 3 + 1] - y;
        const dz = positions[idx * 3 + 2] - z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 <= r2) hits.push({ idx, dist: Math.sqrt(d2) });
      }
    }
  }
  return hits;
}

export function nearestK(
  index: GridIndex,
  x: number,
  y: number,
  z: number,
  k: number,
  radius: number,
): { idx: number; dist: number }[] {
  const hits = queryRadius(index, x, y, z, radius);
  hits.sort((a, b) => a.dist - b.dist);
  return hits.slice(0, k);
}

function cellKey(ix: number, iy: number): string {
  return `${ix},${iy}`;
}
