/** Shared response cache for /api/points, invalidated on dataset changes. */

export interface PointsCacheEntry {
  ipc: Uint8Array;
  total: number;
  rendered: number;
  at: number;
}

const CACHE_BYTE_BUDGET = 256 * 1024 * 1024;
export const POINTS_CACHE_TTL_MS = 60_000;

const responseCache = new Map<string, PointsCacheEntry>();
let cacheBytes = 0;

let countCache: { at: number; total: number } | null = null;

export function getCachedPoints(key: string): PointsCacheEntry | null {
  const entry = responseCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at >= POINTS_CACHE_TTL_MS) {
    responseCache.delete(key);
    cacheBytes -= entry.ipc.byteLength;
    return null;
  }
  return entry;
}

export function setCachedPoints(key: string, entry: PointsCacheEntry) {
  while (cacheBytes + entry.ipc.byteLength > CACHE_BYTE_BUDGET && responseCache.size > 0) {
    const oldest = responseCache.keys().next().value!;
    const evicted = responseCache.get(oldest)!;
    cacheBytes -= evicted.ipc.byteLength;
    responseCache.delete(oldest);
  }
  responseCache.set(key, entry);
  cacheBytes += entry.ipc.byteLength;
}

export function getCachedCount(): number | null {
  if (countCache && Date.now() - countCache.at < POINTS_CACHE_TTL_MS) {
    return countCache.total;
  }
  return null;
}

export function setCachedCount(total: number) {
  countCache = { at: Date.now(), total };
}

/** Drop everything — call after importing or clearing the dataset. */
export function invalidatePointsCache() {
  responseCache.clear();
  cacheBytes = 0;
  countCache = null;
}
