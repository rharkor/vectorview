"use client";

import { Database, KeyRound, Orbit, X } from "lucide-react";
import dynamic from "next/dynamic";
import { useEffect } from "react";

import { ClusterLegend } from "@/components/cluster-legend";
import { DatasetDialog } from "@/components/dataset-dialog";
import { DetailsPanel } from "@/components/details-panel";
import { SearchBar } from "@/components/search-bar";
import { SettingsPopover } from "@/components/settings-popover";
import { StatsFooter } from "@/components/stats-footer";
import { TokenDialog } from "@/components/token-dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useVectorStore } from "@/lib/store";
import { getGatewayToken, onTokenChange } from "@/lib/token";

// deck.gl needs WebGL; never render it on the server.
const VectorCanvas = dynamic(
  () => import("@/components/vector-canvas").then((m) => m.VectorCanvas),
  { ssr: false },
);

export function VectorApp() {
  const viewMode = useVectorStore((s) => s.viewMode);
  const setViewMode = useVectorStore((s) => s.setViewMode);
  const loading = useVectorStore((s) => s.loading);
  const loadProgress = useVectorStore((s) => s.loadProgress);
  const error = useVectorStore((s) => s.error);
  const setError = useVectorStore((s) => s.setError);
  const cloud = useVectorStore((s) => s.cloud);
  const token = useVectorStore((s) => s.token);
  const setToken = useVectorStore((s) => s.setToken);
  const setTokenDialogOpen = useVectorStore((s) => s.setTokenDialogOpen);
  const setDatasetDialogOpen = useVectorStore((s) => s.setDatasetDialogOpen);

  useEffect(() => {
    setToken(getGatewayToken());
    return onTokenChange(() => setToken(getGatewayToken()));
  }, [setToken]);

  return (
    <div className="relative h-dvh w-full overflow-hidden bg-[#050510] text-foreground">
      <VectorCanvas />

      {/* Top bar */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start gap-4 p-4">
        <div className="pointer-events-auto flex h-11 shrink-0 items-center gap-2 rounded-full border border-white/10 bg-black/40 px-4 backdrop-blur-md">
          <Orbit className="size-4 text-sky-400" />
          <span className="text-sm font-semibold tracking-wide">VectorView</span>
        </div>
        <div className="flex min-w-0 flex-1 justify-center">
          <div className="w-full max-w-xl">
            <SearchBar />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="pointer-events-auto flex h-11 items-center rounded-full border border-white/10 bg-black/40 p-1 backdrop-blur-md">
            {(["2d", "3d"] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setViewMode(mode)}
                className={`h-8 rounded-full px-3 text-xs font-medium uppercase transition-colors ${
                  viewMode === mode
                    ? "bg-sky-500/80 text-white"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {mode}
              </button>
            ))}
          </div>
          <SettingsPopover />
          <Button
            variant="outline"
            size="icon"
            onClick={() => setDatasetDialogOpen(true)}
            className="pointer-events-auto border-white/10 bg-black/40 backdrop-blur-md hover:bg-black/60"
            title="Manage dataset"
          >
            <Database className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={() => setTokenDialogOpen(true)}
            className={`pointer-events-auto border-white/10 backdrop-blur-md ${
              token
                ? "bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30"
                : "bg-black/40 hover:bg-black/60"
            }`}
            title={token ? "Gateway token saved" : "Add gateway token"}
          >
            <KeyRound className="size-4" />
          </Button>
        </div>
      </div>

      {/* Loading overlay */}
      {loading && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/30 backdrop-blur-[2px]">
          <div className="flex w-72 flex-col items-center gap-3 rounded-xl border border-white/10 bg-black/60 p-6 backdrop-blur-md">
            <p className="text-sm text-muted-foreground">Loading point cloud…</p>
            <Progress value={loadProgress !== null ? loadProgress * 100 : null} />
            {loadProgress !== null && (
              <p className="font-mono text-xs text-muted-foreground">
                {Math.round(loadProgress * 100)}%
              </p>
            )}
          </div>
        </div>
      )}

      {/* Error / setup banner */}
      {error && !loading && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
          <div className="pointer-events-auto relative w-full max-w-lg rounded-xl border border-white/10 bg-black/70 p-6 backdrop-blur-md">
            <button
              onClick={() => setError(null)}
              className="absolute right-3 top-3 text-muted-foreground hover:text-foreground"
            >
              <X className="size-4" />
            </button>
            <h2 className="mb-2 text-sm font-semibold">Cannot load points</h2>
            <p className="mb-4 break-words font-mono text-xs text-red-300">{error}</p>
            <pre className="overflow-x-auto rounded-md bg-black/50 p-3 font-mono text-[11px] text-muted-foreground">
{`cp .env.example .env   # set DATABASE_URL
pnpm db:migrate         # apply migrations
psql "$DATABASE_URL" -f scripts/seed.sql  # demo data
python scripts/project.py    # compute x/y/z`}
            </pre>
          </div>
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && cloud && cloud.count === 0 && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
          <p className="pointer-events-auto rounded-xl border border-white/10 bg-black/60 px-6 py-4 text-sm text-muted-foreground backdrop-blur-md">
            No projected points found — run{" "}
            <code className="font-mono text-sky-300">python scripts/project.py</code>{" "}
            to compute coordinates.
          </p>
        </div>
      )}

      <div className="pointer-events-none absolute top-32 left-4 z-10">
        <ClusterLegend />
      </div>

      {/* Footer */}
      <div className="absolute bottom-4 left-4 z-10">
        <StatsFooter />
      </div>

      <DetailsPanel />
      <TokenDialog />
      <DatasetDialog />
    </div>
  );
}
