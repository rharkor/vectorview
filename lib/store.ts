"use client";

import { create } from "zustand";

import type { PointRow, SearchResult, ViewMode } from "@/lib/types";

export interface PointCloud {
  ids: string[]; // source_id from the dataset
  labels: string[]; // optional display label per point ("" when unset)
  positions: Float32Array; // interleaved xyz
  colors: Uint8Array; // rgba per point
  count: number;
}

interface FlyTarget {
  x: number;
  y: number;
  z: number;
  nonce: number;
}

interface VectorState {
  cloud: PointCloud | null;
  totalCount: number;
  renderedCount: number;
  loading: boolean;
  loadProgress: number | null;
  error: string | null;

  viewMode: ViewMode;
  pointSize: number;
  sample: number;

  selectedId: string | null;
  selectedPos: [number, number, number] | null;
  selectedPoint: PointRow | null;
  neighbors: PointRow[];
  detailsOpen: boolean;
  detailsLoading: boolean;
  hoverIndex: number | null;

  searchResults: SearchResult[];
  searchQuery: string;
  highlightedIds: Set<string>;

  flyTarget: FlyTarget | null;
  fps: number;

  token: string | null;
  tokenDialogOpen: boolean;

  datasetDialogOpen: boolean;
  dataVersion: number;

  setCloud: (cloud: PointCloud, total: number, rendered: number) => void;
  setLoading: (loading: boolean, progress?: number | null) => void;
  setError: (error: string | null) => void;
  setViewMode: (mode: ViewMode) => void;
  setPointSize: (size: number) => void;
  setSample: (sample: number) => void;
  selectPoint: (id: string | null, pos?: [number, number, number]) => void;
  setHoverIndex: (index: number | null) => void;
  setSelectedPoint: (point: PointRow | null) => void;
  setNeighbors: (neighbors: PointRow[]) => void;
  setDetailsOpen: (open: boolean) => void;
  setDetailsLoading: (loading: boolean) => void;
  setSearchResults: (results: SearchResult[], query: string) => void;
  clearSearch: () => void;
  flyTo: (x: number, y: number, z: number) => void;
  setFps: (fps: number) => void;
  setToken: (token: string | null) => void;
  setTokenDialogOpen: (open: boolean) => void;
  setDatasetDialogOpen: (open: boolean) => void;
  bumpDataVersion: () => void;
}

export const useVectorStore = create<VectorState>((set) => ({
  cloud: null,
  totalCount: 0,
  renderedCount: 0,
  loading: false,
  loadProgress: null,
  error: null,

  viewMode: "2d",
  pointSize: 1,
  sample: 1,

  selectedId: null,
  selectedPos: null,
  selectedPoint: null,
  neighbors: [],
  detailsOpen: false,
  detailsLoading: false,
  hoverIndex: null,

  searchResults: [],
  searchQuery: "",
  highlightedIds: new Set<string>(),

  flyTarget: null,
  fps: 0,

  token: null,
  tokenDialogOpen: false,

  datasetDialogOpen: false,
  dataVersion: 0,

  setCloud: (cloud, totalCount, renderedCount) =>
    set({ cloud, totalCount, renderedCount, loading: false, loadProgress: null, error: null }),
  setLoading: (loading, progress = null) => set({ loading, loadProgress: progress }),
  setError: (error) => set({ error, loading: false, loadProgress: null }),
  setViewMode: (viewMode) => set({ viewMode }),
  setPointSize: (pointSize) => set({ pointSize }),
  setSample: (sample) => set({ sample }),
  selectPoint: (selectedId, pos) =>
    set({
      selectedId,
      selectedPos: pos ?? null,
      detailsOpen: selectedId !== null,
      selectedPoint: null,
      neighbors: [],
      detailsLoading: selectedId !== null,
    }),
  setHoverIndex: (hoverIndex) => set({ hoverIndex }),
  setSelectedPoint: (selectedPoint) => set({ selectedPoint }),
  setNeighbors: (neighbors) => set({ neighbors, detailsLoading: false }),
  setDetailsOpen: (detailsOpen) => set({ detailsOpen }),
  setDetailsLoading: (detailsLoading) => set({ detailsLoading }),
  setSearchResults: (searchResults, searchQuery) =>
    set({
      searchResults,
      searchQuery,
      highlightedIds: new Set(
        searchResults.map((r) => String(r.source_id ?? r.id)),
      ),
    }),
  clearSearch: () =>
    set({ searchResults: [], searchQuery: "", highlightedIds: new Set<string>() }),
  flyTo: (x, y, z) => set({ flyTarget: { x, y, z, nonce: Date.now() } }),
  setFps: (fps) => set({ fps }),
  setToken: (token) => set({ token }),
  setTokenDialogOpen: (tokenDialogOpen) => set({ tokenDialogOpen }),
  setDatasetDialogOpen: (datasetDialogOpen) => set({ datasetDialogOpen }),
  bumpDataVersion: () => set((s) => ({ dataVersion: s.dataVersion + 1 })),
}));

if (process.env.NODE_ENV === "development" && typeof window !== "undefined") {
  (window as unknown as { __vectorStore: typeof useVectorStore }).__vectorStore =
    useVectorStore;
}
