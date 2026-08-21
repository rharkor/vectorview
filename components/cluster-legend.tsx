"use client";

import { useEffect, useMemo } from "react";

import { clusterLabel, clusterRgbCss } from "@/lib/colors";
import { isClusterVisible, useVectorStore } from "@/lib/store";

export function ClusterLegend() {
  const cloud = useVectorStore((s) => s.cloud);
  const selectedClusters = useVectorStore((s) => s.selectedClusters);
  const clusterLabels = useVectorStore((s) => s.clusterLabels);
  const selectCluster = useVectorStore((s) => s.selectCluster);
  const showAllClusters = useVectorStore((s) => s.showAllClusters);
  const setClusterLabels = useVectorStore((s) => s.setClusterLabels);

  useEffect(() => {
    if (!cloud) return;
    let cancelled = false;
    fetch("/api/clusters")
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as {
          labels?: Record<string, string>;
        } | null;
        if (!cancelled && res.ok && body?.labels) setClusterLabels(body.labels);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [cloud, setClusterLabels]);

  const rows = useMemo(() => {
    if (!cloud?.clusters) return [];
    const counts = new Map<number, number>();
    for (let i = 0; i < cloud.count; i++) {
      const id = cloud.clusters[i];
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([id, count]) => ({ id, count }))
      .sort((a, b) => {
        if (a.id < 0) return 1;
        if (b.id < 0) return -1;
        return clusterLabel(a.id, clusterLabels).localeCompare(
          clusterLabel(b.id, clusterLabels),
        );
      });
  }, [cloud, clusterLabels]);

  if (!cloud || rows.length === 0 || !rows.some((r) => r.id >= 0)) return null;

  const filtered = selectedClusters !== null;

  return (
    <div className="pointer-events-auto mt-2 flex w-56 flex-col rounded-xl border border-white/10 bg-black/40 backdrop-blur-md">
      <div className="flex items-center justify-between gap-2 px-3 pt-2.5 pb-1.5">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Clusters
        </p>
        {filtered && (
          <button
            type="button"
            onClick={showAllClusters}
            className="text-[10px] text-sky-300 hover:text-sky-200"
          >
            Show all
          </button>
        )}
      </div>
      <div className="code-scroll max-h-[min(24rem,calc(100dvh-12rem))] overflow-y-auto px-1.5 pb-2">
        <div className="flex flex-col gap-0.5">
          {rows.map((row) => {
            const active = isClusterVisible(selectedClusters, row.id);
            return (
              <button
                key={row.id}
                type="button"
                onClick={() => selectCluster(row.id)}
                className={`flex items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors ${
                  active
                    ? "bg-white/8 hover:bg-white/12"
                    : "opacity-35 hover:opacity-60"
                }`}
                title={
                  active && filtered
                    ? "Remove from selection"
                    : "Show this cluster"
                }
              >
                <span
                  className="size-2.5 shrink-0 rounded-full ring-1 ring-white/20"
                  style={{ background: clusterRgbCss(row.id, cloud.clusterColors) }}
                />
                <span className="min-w-0 flex-1 truncate text-xs">
                  {clusterLabel(row.id, clusterLabels)}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  {row.count.toLocaleString()}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
