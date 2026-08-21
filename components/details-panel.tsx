"use client";

import { ArrowRight, Loader2 } from "lucide-react";
import { useEffect } from "react";
import { toast } from "sonner";

import { CodeBlock } from "@/components/code-block";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useVectorStore } from "@/lib/store";
import type { PointRow } from "@/lib/types";

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function rowId(row: PointRow): string {
  return String(row.source_id ?? row.id);
}

function previewLabel(row: PointRow): string {
  if (row.label) return String(row.label);
  const payload = row.payload;
  if (payload && typeof payload === "object") {
    const name = (payload as Record<string, unknown>).name;
    if (name) return String(name);
  }
  return rowId(row);
}

/** Fields rendered as key/value rows; payload gets the Shiki block instead. */
const HIDDEN_KEYS = new Set(["x", "y", "z", "payload", "source_id", "label"]);

export function DetailsPanel() {
  const open = useVectorStore((s) => s.detailsOpen);
  const setOpen = useVectorStore((s) => s.setDetailsOpen);
  const selectedId = useVectorStore((s) => s.selectedId);
  const point = useVectorStore((s) => s.selectedPoint);
  const neighbors = useVectorStore((s) => s.neighbors);
  const loading = useVectorStore((s) => s.detailsLoading);
  const setSelectedPoint = useVectorStore((s) => s.setSelectedPoint);
  const setNeighbors = useVectorStore((s) => s.setNeighbors);
  const flyTo = useVectorStore((s) => s.flyTo);
  const selectPoint = useVectorStore((s) => s.selectPoint);

  useEffect(() => {
    if (selectedId === null) return;
    let cancelled = false;

    const load = async () => {
      try {
        const encoded = encodeURIComponent(selectedId);
        const [pointRes, neighborsRes] = await Promise.all([
          fetch(`/api/points/${encoded}`),
          fetch(`/api/points/${encoded}/neighbors?k=20`),
        ]);
        const pointBody = (await pointRes.json()) as {
          point?: PointRow;
          error?: string;
        };
        const neighborsBody = (await neighborsRes.json()) as {
          neighbors?: PointRow[];
          error?: string;
        };
        if (cancelled) return;
        if (!pointRes.ok) {
          toast.error(pointBody.error ?? "Failed to load point");
          return;
        }
        setSelectedPoint(pointBody.point ?? null);
        if (neighborsRes.ok) {
          setNeighbors(neighborsBody.neighbors ?? []);
        } else {
          setNeighbors([]);
          toast.error(neighborsBody.error ?? "Failed to load neighbors");
        }
      } catch (error) {
        if (!cancelled) {
          toast.error(error instanceof Error ? error.message : "Request failed");
        }
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [selectedId, setSelectedPoint, setNeighbors]);

  const entries = point
    ? Object.entries(point).filter(([key]) => !HIDDEN_KEYS.has(key))
    : [];

  const title = point?.label
    ? String(point.label)
    : selectedId !== null
      ? `#${selectedId}`
      : "Point";

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent
        side="right"
        className="w-full data-[side=right]:w-full data-[side=right]:sm:max-w-3xl data-[side=right]:xl:max-w-4xl"
      >
        <SheetHeader>
          <SheetTitle className="truncate">{title}</SheetTitle>
          <SheetDescription className="truncate">
            {point?.label && selectedId ? `id: ${selectedId} · ` : ""}
            Exact row data and its nearest neighbors by cosine distance.
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="min-h-0 flex-1 px-4 pb-4">
          {loading && (
            <div className="flex flex-col gap-2 py-2">
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="h-5 w-1/2" />
              <Skeleton className="h-24 w-full" />
            </div>
          )}

          {!loading && point && (
            <>
              {entries.length > 0 && (
                <div className="rounded-lg border border-border">
                  {entries.map(([key, value]) => (
                    <div
                      key={key}
                      className="flex items-start justify-between gap-4 border-b border-border px-3 py-2 text-sm last:border-0"
                    >
                      <span className="shrink-0 font-mono text-xs text-muted-foreground">
                        {key}
                      </span>
                      <span className="break-all text-right font-mono text-xs">
                        {formatValue(value)}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {typeof point.cluster === "number" && point.cluster >= 0 && (
                <div className="mt-3">
                  <Badge variant="outline">cluster {point.cluster}</Badge>
                </div>
              )}

              {point.payload !== undefined && point.payload !== null && (
                <div className="mt-3">
                  <div className="mb-1.5 text-xs font-medium text-muted-foreground">
                    payload
                  </div>
                  <CodeBlock
                    code={JSON.stringify(point.payload, null, 2)}
                    lang="json"
                  />
                </div>
              )}

              <Separator className="my-4" />

              <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                Nearest neighbors
                {loading && <Loader2 className="size-3 animate-spin" />}
              </div>
              <div className="flex flex-col gap-1">
                {neighbors.map((n) => (
                  <button
                    key={rowId(n)}
                    onClick={() => {
                      if (typeof n.x === "number" && typeof n.y === "number") {
                        const pos: [number, number, number] = [
                          n.x,
                          n.y,
                          (n.z as number) ?? 0,
                        ];
                        flyTo(...pos);
                        selectPoint(rowId(n), pos);
                      } else {
                        selectPoint(rowId(n));
                      }
                    }}
                    className="group flex items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-left text-sm transition-colors hover:border-border hover:bg-accent"
                  >
                    <span className="min-w-0 flex-1 truncate">{previewLabel(n)}</span>
                    {typeof n.distance === "number" && (
                      <Badge variant="secondary" className="shrink-0 font-mono text-[10px]">
                        {n.distance.toFixed(4)}
                      </Badge>
                    )}
                    <ArrowRight className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-60" />
                  </button>
                ))}
                {neighbors.length === 0 && !loading && (
                  <p className="px-2 py-1 text-sm text-muted-foreground">
                    No neighbors found.
                  </p>
                )}
              </div>
            </>
          )}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
