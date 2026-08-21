export interface PointRow {
  id: number | string;
  source_id?: string;
  label?: string;
  x?: number;
  y?: number;
  z?: number;
  cluster?: number;
  distance?: number;
  [key: string]: unknown;
}

export interface SearchResult extends PointRow {
  distance: number;
}

export type ViewMode = "2d" | "3d";
