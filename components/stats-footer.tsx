"use client";

import { Activity, Database, Layers } from "lucide-react";

import { useVectorStore } from "@/lib/store";

export function StatsFooter() {
  const renderedCount = useVectorStore((s) => s.renderedCount);
  const totalCount = useVectorStore((s) => s.totalCount);
  const fps = useVectorStore((s) => s.fps);
  const sample = useVectorStore((s) => s.sample);
  const viewMode = useVectorStore((s) => s.viewMode);

  return (
    <div className="pointer-events-auto flex items-center gap-4 rounded-full border border-white/10 bg-black/40 px-4 py-1.5 font-mono text-[11px] text-muted-foreground backdrop-blur-md">
      <span className="flex items-center gap-1.5">
        <Layers className="size-3" />
        {renderedCount.toLocaleString()}
        {totalCount > renderedCount && ` / ${totalCount.toLocaleString()}`} pts
      </span>
      <span className="flex items-center gap-1.5">
        <Activity className="size-3" />
        {fps > 0 ? `${fps} fps` : "idle"}
      </span>
      <span className="flex items-center gap-1.5">
        <Database className="size-3" />
        {sample < 1 ? `${(sample * 100).toFixed(0)}% sample` : "full scan"}
      </span>
      <span className="uppercase">{viewMode}</span>
    </div>
  );
}
