"use client";

import { Crosshair, Eye, EyeOff, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { clusterLabel, clusterRgbCss } from "@/lib/colors";
import { isClusterVisible, useVectorStore } from "@/lib/store";

export function ClusterLegend() {
	const cloud = useVectorStore((s) => s.cloud);
	const hiddenClusters = useVectorStore((s) => s.hiddenClusters);
	const focusedCluster = useVectorStore((s) => s.focusedCluster);
	const clusterLabels = useVectorStore((s) => s.clusterLabels);
	const toggleClusterHidden = useVectorStore((s) => s.toggleClusterHidden);
	const showAllClusters = useVectorStore((s) => s.showAllClusters);
	const focusCluster = useVectorStore((s) => s.focusCluster);
	const setClusterLabels = useVectorStore((s) => s.setClusterLabels);
	const [filter, setFilter] = useState("");

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

	const visibleRows = useMemo(() => {
		const q = filter.trim().toLowerCase();
		if (!q) return rows;
		return rows.filter((row) => {
			const label = clusterLabel(row.id, clusterLabels).toLowerCase();
			return label.includes(q) || String(row.id).includes(q);
		});
	}, [rows, filter, clusterLabels]);

	if (!cloud || rows.length === 0 || !rows.some((r) => r.id >= 0)) return null;

	const someHidden = hiddenClusters.size > 0;

	return (
		<div className="pointer-events-auto flex w-80 flex-col gap-2 rounded-xl border border-white/10 bg-black/40 pt-2 backdrop-blur-md">
			<div className="flex shrink-0 items-center justify-between gap-2 px-3 pt-2.5 pb-1.5">
				<p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
					Clusters
				</p>
				{someHidden && (
					<button
						type="button"
						onClick={showAllClusters}
						className="text-[10px] text-sky-300 hover:text-sky-200"
					>
						Show all
					</button>
				)}
			</div>
			<div className="shrink-0 px-2 pb-1.5">
				<label className="flex items-center gap-1.5 rounded-md border border-white/10 bg-black/30 px-2 py-1">
					<Search className="size-3 shrink-0 text-muted-foreground" />
					<input
						value={filter}
						onChange={(e) => setFilter(e.target.value)}
						placeholder="Filter clusters…"
						className="w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
					/>
				</label>
			</div>
			<div className="code-scroll max-h-64 overflow-y-auto px-1.5 pb-2">
				<div className="flex flex-col gap-0.5">
					{visibleRows.map((row) => {
						const shown = isClusterVisible(hiddenClusters, row.id);
						const focused = focusedCluster === row.id;
						return (
							<div
								key={row.id}
								className={`flex items-center gap-1.5 rounded-md px-1.5 py-1 ${
									focused ? "bg-white/10" : shown ? "bg-white/4" : ""
								} ${shown ? "" : "opacity-45"}`}
							>
								<span
									className="size-2.5 shrink-0 rounded-full ring-1 ring-white/20"
									style={{
										background: clusterRgbCss(row.id, cloud.clusterColors),
									}}
								/>
								<span
									className="min-w-0 flex-1 truncate text-xs"
									title={clusterLabel(row.id, clusterLabels)}
								>
									{clusterLabel(row.id, clusterLabels)}
								</span>
								<span className="shrink-0 font-mono text-[10px] text-muted-foreground">
									{row.count.toLocaleString()}
								</span>
								<button
									type="button"
									onClick={() => toggleClusterHidden(row.id)}
									className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-white/10 hover:text-foreground"
									title={shown ? "Hide cluster" : "Show cluster"}
								>
									{shown ? (
										<Eye className="size-3" />
									) : (
										<EyeOff className="size-3" />
									)}
								</button>
								<button
									type="button"
									onClick={() => focusCluster(row.id)}
									className={`flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[10px] font-medium uppercase ${
										focused
											? "bg-sky-400 text-zinc-950"
											: "text-muted-foreground hover:bg-white/10 hover:text-foreground"
									}`}
									title={
										focused
											? "Clear cluster focus"
											: "Highlight and frame this cluster"
									}
								>
									<Crosshair className="size-3" />
									Focus
								</button>
							</div>
						);
					})}
					{visibleRows.length === 0 && (
						<p className="px-1.5 py-2 text-xs text-muted-foreground">
							No matches
						</p>
					)}
				</div>
			</div>
		</div>
	);
}
