const KEY = "vectorview:import-options:v2";

export interface ImportOptions {
  pageSize: number;
  connections: number;
  includePayload: boolean;
  fetchTimeoutSec: number;
  umapFitMax: number;
  buildHnsw: boolean;
}

export const DEFAULT_IMPORT_OPTIONS: ImportOptions = {
  pageSize: 150,
  connections: 1,
  includePayload: false,
  fetchTimeoutSec: 120,
  umapFitMax: 12_000,
  buildHnsw: true,
};

export function getImportOptions(): ImportOptions {
  if (typeof window === "undefined") return DEFAULT_IMPORT_OPTIONS;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULT_IMPORT_OPTIONS;
    return { ...DEFAULT_IMPORT_OPTIONS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_IMPORT_OPTIONS;
  }
}

export function setImportOptions(options: ImportOptions) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(KEY, JSON.stringify(options));
}
