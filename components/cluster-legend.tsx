"use client";

import { Command } from "cmdk";
import { Check, ChevronsUpDown, Crosshair, Eye, EyeOff, Loader2, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
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
	const bumpDataVersion = useVectorStore((s) => s.bumpDataVersion);
	const [filter, setFilter] = useState("");
	const [clusterColumn, setClusterColumn] = useState<string | null>(null);
	const [clusterFields, setClusterFields] = useState<string[]>([]);
	const [recoloring, setRecoloring] = useState(false);
	const [fieldOpen, setFieldOpen] = useState(false);
	const [fieldSearch, setFieldSearch] = useState("");

	useEffect(() => {
		if (!cloud) return;
		let cancelled = false;
		fetch("/api/clusters")
			.then(async (res) => {
				const body = (await res.json().catch(() => null)) as {
					labels?: Record<string, string>;
					column?: string | null;
					fields?: string[];
				} | null;
				if (cancelled || !res.ok || !body) return;
				if (body.labels) setClusterLabels(body.labels);
				setClusterColumn(body.column ?? null);
				setClusterFields(body.fields ?? []);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [cloud, setClusterLabels]);

	const changeClusterField = async (column: string) => {
		if (!column || column === clusterColumn || recoloring) return;
		setRecoloring(true);
		try {
			const res = await fetch("/api/clusters", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ column }),
			});
			const body = (await res.json().catch(() => null)) as {
				labels?: Record<string, string>;
				column?: string;
				error?: string;
			} | null;
			if (!res.ok) {
				toast.error(body?.error ?? "Could not change cluster field");
				return;
			}
			if (body?.labels) setClusterLabels(body.labels);
			setClusterColumn(body?.column ?? column);
			bumpDataVersion();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not change cluster field");
		} finally {
			setRecoloring(false);
		}
	};

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

	if (!cloud) return null;

	const hasClusters = rows.some((r) => r.id >= 0);
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
			<div className="shrink-0 px-2">
				<Popover
					open={fieldOpen}
					onOpenChange={(open) => {
						setFieldOpen(open);
						if (!open) setFieldSearch("");
					}}
				>
					<PopoverTrigger
						disabled={recoloring || clusterFields.length === 0}
						render={
							<Button
								variant="outline"
								size="sm"
								className="h-8 w-full justify-between border-white/10 bg-black/30 px-2 font-normal text-xs hover:bg-black/50"
								title="Color points by this payload field"
							>
								<span className="min-w-0 truncate">
									{recoloring
										? "Updating…"
										: clusterColumn ??
											(clusterFields.length === 0
												? "No payload fields"
												: "Choose a field…")}
								</span>
								{recoloring ? (
									<Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
								) : (
									<ChevronsUpDown className="size-3 shrink-0 text-muted-foreground" />
								)}
							</Button>
						}
					/>
					<PopoverContent
						align="start"
						side="bottom"
						className="w-(--anchor-width) p-0"
					>
						<Command className="flex w-full flex-col">
							<Command.Input
								placeholder="Search fields…"
								value={fieldSearch}
								onValueChange={setFieldSearch}
								className="h-8 w-full border-b border-border bg-transparent px-2.5 text-xs outline-none placeholder:text-muted-foreground"
							/>
							<Command.List className="code-scroll max-h-48 overflow-y-auto p-1">
								<Command.Empty className="px-2 py-2 text-xs text-muted-foreground">
									No fields found.
								</Command.Empty>
								{clusterFields.map((field) => (
									<Command.Item
										key={field}
										value={field}
										onSelect={() => {
											setFieldOpen(false);
											void changeClusterField(field);
										}}
										className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs outline-none data-[selected=true]:bg-accent"
									>
										<Check
											className={`size-3 shrink-0 ${
												clusterColumn === field ? "opacity-100" : "opacity-0"
											}`}
										/>
										<span className="min-w-0 flex-1 truncate">{field}</span>
									</Command.Item>
								))}
							</Command.List>
						</Command>
					</PopoverContent>
				</Popover>
			</div>
			{hasClusters && (
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
			)}
			<div className="code-scroll max-h-64 overflow-y-auto px-1.5 pb-2">
				<div className="flex flex-col gap-0.5">
					{!hasClusters && (
						<p className="px-1.5 py-2 text-xs text-muted-foreground">
							{clusterFields.length === 0
								? "Re-import with full payload to color by a column."
								: "Choose a field to color the map."}
						</p>
					)}
					{hasClusters && visibleRows.map((row) => {
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
					{hasClusters && visibleRows.length === 0 && (
						<p className="px-1.5 py-2 text-xs text-muted-foreground">
							No matches
						</p>
					)}
				</div>
			</div>
		</div>
	);
}
