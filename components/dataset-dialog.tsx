"use client";

import { Command } from "cmdk";
import {
	Check,
	ChevronsUpDown,
	Database,
	Loader2,
	Plug,
	SlidersHorizontal,
	Trash2,
	Upload,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
	DEFAULT_IMPORT_OPTIONS,
	getImportOptions,
	setImportOptions,
	type ImportOptions,
} from "@/lib/import-options";
import { getSourceUrl, setSourceUrl } from "@/lib/source-url";
import { useVectorStore } from "@/lib/store";

interface SourceColumn {
	name: string;
	dataType: string;
	udt: string;
	vectorDim: number | null;
	isPrimaryKey: boolean;
}

interface SourceTable {
	schema: string;
	name: string;
	estimatedRows: number;
	hasEmbeddings: boolean;
	columns: SourceColumn[];
	suggestion: {
		idColumn: string | null;
		embeddingColumn: string | null;
		embeddingDim: number | null;
		clusterColumn: string | null;
		labelColumn: string | null;
		xColumn: string | null;
		yColumn: string | null;
		zColumn: string | null;
	};
}

interface DatasetInfo {
	rowCount: number;
	projectedCount: number;
	source: {
		label: string;
		table: string;
		embeddingDim: number | null;
		importedAt: string;
	} | null;
}

interface ProgressEvent {
	phase: string;
	step?: string;
	message?: string;
	done?: number;
	total?: number;
	rows?: number;
	error?: string;
}

const NONE = "__none__";

const STEP_LABELS: Record<string, string> = {
	"pca-fit": "Fitting PCA",
	"pca-transform": "Reducing dimensions",
	"umap-fit": "Running UMAP",
	"umap-transform": "Projecting remaining points",
	"write-back": "Writing coordinates",
};

export function DatasetDialog() {
	const open = useVectorStore((s) => s.datasetDialogOpen);
	const setOpen = useVectorStore((s) => s.setDatasetDialogOpen);
	const bumpDataVersion = useVectorStore((s) => s.bumpDataVersion);

	const [info, setInfo] = useState<DatasetInfo | null>(null);
	const [infoError, setInfoError] = useState<string | null>(null);
	const [confirmClear, setConfirmClear] = useState(false);
	const [clearing, setClearing] = useState(false);

	const [url, setUrl] = useState("");
	const [connecting, setConnecting] = useState(false);
	const [tables, setTables] = useState<SourceTable[] | null>(null);
	const [sourceLabel, setSourceLabel] = useState("");
	const [selectedKey, setSelectedKey] = useState<string>("");
	const [mapping, setMapping] = useState({
		idColumn: "",
		embeddingColumn: "",
		clusterColumn: NONE,
		labelColumn: NONE,
		xColumn: NONE,
		yColumn: NONE,
		zColumn: NONE,
	});

	const [importing, setImporting] = useState(false);
	const [progress, setProgress] = useState<ProgressEvent | null>(null);
	const [importDone, setImportDone] = useState<{ rows: number } | null>(null);
	const [tableOpen, setTableOpen] = useState(false);
	const [exactCount, setExactCount] = useState<number | null>(null);
	const [embeddingCount, setEmbeddingCount] = useState<number | null>(null);
	const [counting, setCounting] = useState(false);
	const countRequest = useRef(0);
	const [tableSearch, setTableSearch] = useState("");
	const [searchingTables, setSearchingTables] = useState(false);
	const [totalTables, setTotalTables] = useState<number | null>(null);
	const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [showMore, setShowMore] = useState(false);
	const [importOptions, setOptionsState] = useState<ImportOptions>(
		DEFAULT_IMPORT_OPTIONS,
	);

	const updateOptions = (patch: Partial<ImportOptions>) => {
		setOptionsState((prev) => {
			const next = { ...prev, ...patch };
			setImportOptions(next);
			return next;
		});
	};

	// All state updates happen after the fetch settles, never synchronously —
	// this keeps the effect below free of sync setState.
	const refreshInfo = useCallback(async () => {
		try {
			const res = await fetch("/api/dataset");
			const body = await res.json().catch(() => null);
			if (!res.ok) {
				setInfo(null);
				setInfoError(body?.error ?? `HTTP ${res.status}`);
				return;
			}
			setInfoError(null);
			setInfo(body);
		} catch (error) {
			setInfo(null);
			setInfoError(error instanceof Error ? error.message : "Request failed");
		}
	}, []);

	// The dialog is opened programmatically via the store, so onOpenChange never
	// fires for opening — fetch info from an effect on `open` instead. State is
	// only set from promise callbacks, never synchronously in the effect body.
	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		fetch("/api/dataset")
			.then(async (res) => {
				const body = await res.json().catch(() => null);
				if (cancelled) return;
				if (!res.ok) {
					setInfo(null);
					setInfoError(body?.error ?? `HTTP ${res.status}`);
				} else {
					setInfoError(null);
					setInfo(body);
				}
			})
			.catch((error: unknown) => {
				if (cancelled) return;
				setInfo(null);
				setInfoError(error instanceof Error ? error.message : "Request failed");
			});
		return () => {
			cancelled = true;
		};
	}, [open]);

	// Reset the clear confirmation whenever the dialog opens (render-phase
	// adjust pattern, the lint-safe way to derive state from prop changes).
	const [wasOpen, setWasOpen] = useState(open);
	if (open !== wasOpen) {
		setWasOpen(open);
		setConfirmClear(false);
		if (open) {
			const saved = getSourceUrl();
			if (saved) setUrl(saved);
			setOptionsState(getImportOptions());
		}
	}

	const handleOpenChange = (v: boolean) => {
		if (importing) return;
		setOpen(v);
	};

	const selectedTable =
		tables?.find((t) => `${t.schema}.${t.name}` === selectedKey) ?? null;

	const fetchTables = async (term: string, autoSelect: boolean) => {
		const res = await fetch("/api/dataset/preview", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				url: url.trim(),
				search: term || undefined,
			}),
		});
		const body = await res.json();
		if (!res.ok) throw new Error(body.error ?? "Could not connect");
		setTables(body.tables);
		setSourceLabel(body.source);
		setTotalTables(body.totalTables ?? body.tables.length);
		if (autoSelect) {
			const first = body.tables.find((t: SourceTable) =>
				hasMapping(t.suggestion),
			);
			if (first) selectTable(first);
		}
		return body.tables.length as number;
	};

	const connect = async () => {
		setConnecting(true);
		setTables(null);
		setTableSearch("");
		try {
			const count = await fetchTables("", true);
			setSourceUrl(url);
			toast.success(`Connected — ${count} tables shown`);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Connection failed");
		} finally {
			setConnecting(false);
		}
	};

	// Server-side table search (debounced): the endpoint returns at most 100
	// tables, so searching filters on the source to find tables beyond that.
	const onTableSearchChange = (value: string) => {
		setTableSearch(value);
		if (searchDebounce.current) clearTimeout(searchDebounce.current);
		searchDebounce.current = setTimeout(() => {
			setSearchingTables(true);
			fetchTables(value, false)
				.catch((error: unknown) =>
					toast.error(error instanceof Error ? error.message : "Search failed"),
				)
				.finally(() => setSearchingTables(false));
		}, 300);
	};

	const hasMapping = (s: SourceTable["suggestion"]) =>
		Boolean(s.idColumn && s.embeddingColumn);

	const selectTable = (t: SourceTable) => {
		setSelectedKey(`${t.schema}.${t.name}`);
		setMapping({
			idColumn: t.suggestion.idColumn ?? "",
			embeddingColumn: t.suggestion.embeddingColumn ?? "",
			clusterColumn: t.suggestion.clusterColumn ?? NONE,
			labelColumn: t.suggestion.labelColumn ?? NONE,
			xColumn: t.suggestion.xColumn ?? NONE,
			yColumn: t.suggestion.yColumn ?? NONE,
			zColumn: t.suggestion.zColumn ?? NONE,
		});

		// pg_stat row estimates can be stale (0 for never-analyzed tables) —
		// fetch the exact counts in the background.
		loadCount(t.schema, t.name, t.suggestion.embeddingColumn);
	};

	const loadCount = (schema: string, table: string, embCol: string | null) => {
		const requestId = ++countRequest.current;
		setExactCount(null);
		setEmbeddingCount(null);
		setCounting(true);
		fetch("/api/dataset/count", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				url: url.trim(),
				schema,
				table,
				embeddingColumn: embCol,
			}),
		})
			.then(async (res) => {
				const body = await res.json().catch(() => null);
				if (countRequest.current !== requestId) return;
				if (res.ok && typeof body?.count === "number") {
					setExactCount(body.count);
					setEmbeddingCount(
						typeof body.embeddingCount === "number" ? body.embeddingCount : null,
					);
				}
			})
			.catch(() => {})
			.finally(() => {
				if (countRequest.current === requestId) setCounting(false);
			});
	};

	const clear = async () => {
		if (!confirmClear) {
			setConfirmClear(true);
			return;
		}
		setClearing(true);
		try {
			const res = await fetch("/api/dataset", { method: "DELETE" });
			if (!res.ok) {
				const body = await res.json();
				toast.error(body.error ?? "Clear failed");
				return;
			}
			toast.success("Dataset cleared");
			setConfirmClear(false);
			bumpDataVersion();
			await refreshInfo();
		} finally {
			setClearing(false);
		}
	};

	const runImport = async () => {
		if (!selectedTable) return;
		setImporting(true);
		setImportDone(null);
		setProgress({ phase: "connecting" });
		try {
			const res = await fetch("/api/dataset/import", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						url: url.trim(),
						schema: selectedTable.schema,
						table: selectedTable.name,
						idColumn: mapping.idColumn,
						embeddingColumn: mapping.embeddingColumn,
						clusterColumn:
							mapping.clusterColumn === NONE ? null : mapping.clusterColumn,
						labelColumn:
							mapping.labelColumn === NONE ? null : mapping.labelColumn,
						xColumn: mapping.xColumn === NONE ? null : mapping.xColumn,
						yColumn: mapping.yColumn === NONE ? null : mapping.yColumn,
						zColumn: mapping.zColumn === NONE ? null : mapping.zColumn,
						...importOptions,
					}),
			});
			if (!res.ok || !res.body) {
				const body = await res.json().catch(() => null);
				toast.error(body?.error ?? `Import failed (HTTP ${res.status})`);
				setImporting(false);
				setProgress(null);
				return;
			}

			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const events = buffer.split("\n\n");
				buffer = events.pop() ?? "";
				for (const chunk of events) {
					const line = chunk.trim();
					if (!line.startsWith("data:")) continue;
					const event = JSON.parse(line.slice(5)) as ProgressEvent;
					setProgress(event);
					if (event.phase === "done") {
						setImportDone({ rows: Number(event.rows ?? 0) });
						toast.success(
							`Imported ${Number(event.rows ?? 0).toLocaleString()} rows`,
						);
						bumpDataVersion();
						await refreshInfo();
					}
					if (event.phase === "error") {
						toast.error(event.error ?? "Import failed");
					}
				}
			}
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Import failed");
		} finally {
			setImporting(false);
		}
	};

	const progressPercent = (p: ProgressEvent): number | null => {
		if (p.done !== undefined && p.total && p.total > 0)
			return (p.done / p.total) * 100;
		return null;
	};

	const progressLabel = (p: ProgressEvent): string => {
		if (p.message) return p.message;
		if (p.phase === "copying") return "Copying rows";
		if (p.phase === "projecting" && p.step)
			return STEP_LABELS[p.step] ?? p.step;
		if (p.phase === "indexing") return "Building indexes";
		if (p.phase === "done") return "Import complete";
		if (p.phase === "error") return "Import failed";
		return p.phase;
	};

	const columnOptions = (filter?: (c: SourceColumn) => boolean) =>
		(selectedTable?.columns ?? []).filter((c) => !filter || filter(c));

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<Database className="size-4" />
						Dataset
					</DialogTitle>
					<DialogDescription>
						The app stores its own copy of the data. Import from any Postgres
						database (connected read-only) or clear the current dataset.
					</DialogDescription>
				</DialogHeader>

				{/* Current dataset */}
				<div className="rounded-lg border border-border p-3 text-sm">
					{info && info.rowCount > 0 ? (
						<div className="flex items-center justify-between gap-3">
							<div className="min-w-0">
								<div className="font-medium">
									{info.rowCount.toLocaleString()} rows
									{info.source?.embeddingDim
										? ` · ${info.source.embeddingDim} dims`
										: ""}
								</div>
								<div className="truncate text-xs text-muted-foreground">
									{info.source
										? `${info.source.label} → ${info.source.table}`
										: "loaded externally"}
								</div>
							</div>
							<Button
								variant={confirmClear ? "destructive" : "outline"}
								size="sm"
								onClick={clear}
								disabled={clearing || importing}
							>
								{clearing ? (
									<Loader2 className="size-4 animate-spin" />
								) : (
									<Trash2 className="size-4" />
								)}
								{confirmClear ? "Confirm delete" : "Clear"}
							</Button>
						</div>
					) : infoError ? (
						<div className="flex items-center justify-between gap-3">
							<p className="text-red-300">
								Couldn&apos;t reach the dataset API: {infoError}
							</p>
							<Button
								variant="outline"
								size="sm"
								onClick={() => {
									setInfoError(null);
									void refreshInfo();
								}}
							>
								Retry
							</Button>
						</div>
					) : info === null ? (
						<p className="flex items-center gap-2 text-muted-foreground">
							<Loader2 className="size-3 animate-spin" /> Loading dataset info…
						</p>
					) : (
						<p className="text-muted-foreground">No dataset loaded.</p>
					)}
				</div>

				<Separator />

				{/* Import wizard */}
				{!importing && !importDone && (
					<div className="grid gap-3">
						<div className="grid gap-1.5">
							<Label htmlFor="source-url">Source database URL</Label>
							<div className="flex gap-2">
								<Input
									id="source-url"
									type="text"
									placeholder="postgres://user:pass@host:5432/dbname"
									value={url}
									onChange={(e) => {
										const next = e.target.value;
										setUrl(next);
										setSourceUrl(next);
									}}
									autoComplete="off"
								/>
								<Button onClick={connect} disabled={connecting || !url.trim()}>
									{connecting ? (
										<Loader2 className="size-4 animate-spin" />
									) : (
										<Plug className="size-4" />
									)}
									Connect
								</Button>
							</div>
							<p className="text-xs text-muted-foreground">
								Read-only access is enforced at the connection level. The URL is
								remembered in this browser.
							</p>
						</div>

						{tables && (
							<>
								<div className="grid gap-1.5">
									<Label>
										Table{" "}
										<span className="font-normal text-xs text-muted-foreground">
											from {sourceLabel}
										</span>
									</Label>
									<Popover open={tableOpen} onOpenChange={setTableOpen}>
										<PopoverTrigger
											render={
												<Button
													variant="outline"
													className="w-full justify-between font-normal"
												>
													<span className="min-w-0 truncate">
														{selectedKey || "Select a table"}
													</span>
													<ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
												</Button>
											}
										/>
									<PopoverContent className="w-[var(--anchor-width)] p-0">
										<Command shouldFilter={false} className="flex w-full flex-col">
											<div className="relative">
												<Command.Input
													placeholder="Search tables…"
													value={tableSearch}
													onValueChange={onTableSearchChange}
													className="h-9 w-full border-b border-border bg-transparent px-3 pr-8 text-sm outline-none placeholder:text-muted-foreground"
												/>
												{searchingTables && (
													<Loader2 className="absolute right-2.5 top-2.5 size-4 animate-spin text-muted-foreground" />
												)}
											</div>
											{totalTables !== null && tables && totalTables > tables.length && (
												<p className="border-b border-border px-3 py-1.5 text-[11px] text-muted-foreground">
													Showing {tables.length} of {totalTables} tables — type
													to search the rest
												</p>
											)}
											<Command.List className="max-h-64 overflow-y-auto p-1">
												<Command.Empty className="px-2 py-3 text-sm text-muted-foreground">
													No tables found.
												</Command.Empty>
													{tables.map((t) => {
														const key = `${t.schema}.${t.name}`;
														return (
															<Command.Item
																key={key}
																value={key}
																keywords={[t.schema, t.name]}
																onSelect={() => {
																	selectTable(t);
																	setTableOpen(false);
																}}
																className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[selected=true]:bg-accent"
															>
																<Check
																	className={`size-3.5 shrink-0 ${
																		selectedKey === key
																			? "opacity-100"
																			: "opacity-0"
																	}`}
																/>
																<span className="min-w-0 flex-1 truncate">
																	{key}
																</span>
																<span className="shrink-0 text-xs text-muted-foreground">
																	~{t.estimatedRows.toLocaleString()}
																</span>
																{t.hasEmbeddings && (
																	<Badge
																		variant="secondary"
																		className="shrink-0 text-[10px]"
																	>
																		vector
																	</Badge>
																)}
															</Command.Item>
														);
													})}
												</Command.List>
											</Command>
										</PopoverContent>
									</Popover>
								</div>

								{selectedTable && (
									<div className="grid grid-cols-2 gap-3">
										<ColumnSelect
											label="ID column"
											value={mapping.idColumn}
											onChange={(v) =>
												setMapping((m) => ({ ...m, idColumn: v }))
											}
											columns={columnOptions()}
										/>
									<ColumnSelect
										label="Embedding column"
										value={mapping.embeddingColumn}
										onChange={(v) => {
											setMapping((m) => ({ ...m, embeddingColumn: v }));
											if (selectedTable) {
												loadCount(selectedTable.schema, selectedTable.name, v);
											}
										}}
										columns={columnOptions((c) => c.udt === "vector")}
									/>
									<ColumnSelect
										label="Cluster column (optional)"
										value={mapping.clusterColumn}
										onChange={(v) =>
											setMapping((m) => ({ ...m, clusterColumn: v }))
										}
										columns={columnOptions((c) => c.udt !== "vector")}
										allowNone
									/>
									<ColumnSelect
										label="Label column (optional, shown on hover)"
										value={mapping.labelColumn}
										onChange={(v) =>
											setMapping((m) => ({ ...m, labelColumn: v }))
										}
										columns={columnOptions((c) => c.udt !== "vector")}
										allowNone
									/>
										<div className="grid grid-cols-3 gap-1.5">
											{(["x", "y", "z"] as const).map((axis) => (
												<ColumnSelect
													key={axis}
													label={axis.toUpperCase()}
													value={
														mapping[`${axis}Column` as keyof typeof mapping]
													}
													onChange={(v) =>
														setMapping((m) => ({ ...m, [`${axis}Column`]: v }))
													}
													columns={columnOptions((c) =>
														["float4", "float8", "numeric"].includes(c.udt),
													)}
													allowNone
												/>
											))}
										</div>
										{mapping.xColumn !== NONE && mapping.yColumn !== NONE && (
											<p className="col-span-2 text-xs text-muted-foreground">
												Source coordinates detected — projection will be
												skipped.
											</p>
										)}
									</div>
								)}

								{selectedTable && (
									<>
										{embeddingCount !== null &&
											exactCount !== null &&
											embeddingCount < exactCount && (
												<p
													className={`text-xs ${embeddingCount === 0 ? "text-red-400" : "text-amber-400/90"}`}
												>
													{embeddingCount === 0
														? `No rows have a non-null ${mapping.embeddingColumn} — nothing to import.`
														: `Only ${embeddingCount.toLocaleString()} of ${exactCount.toLocaleString()} rows have a non-null ${mapping.embeddingColumn} — only those will be imported.`}
												</p>
											)}
										<div className="flex flex-wrap items-center gap-2">
											<Button
												onClick={runImport}
												disabled={
													!mapping.idColumn ||
													!mapping.embeddingColumn ||
													importing ||
													embeddingCount === 0
												}
											>
												{counting ? (
													<Loader2 className="size-4 animate-spin" />
												) : (
													<Upload className="size-4" />
												)}
												Import{" "}
												{(embeddingCount ?? exactCount) !== null
													? (embeddingCount ?? exactCount)!.toLocaleString()
													: `~${selectedTable.estimatedRows.toLocaleString()}`}{" "}
												rows
											</Button>
											<Button
												type="button"
												variant="ghost"
												size="sm"
												onClick={() => setShowMore((v) => !v)}
												className="text-muted-foreground"
											>
												<SlidersHorizontal className="size-3.5" />
												{showMore ? "Hide options" : "More options"}
											</Button>
										</div>
										{showMore && (
											<div className="grid gap-3 rounded-lg border border-border p-3">
												<p className="text-xs text-muted-foreground">
													kubectl relay is still one tunnel. Keep a single
													connection and moderate page size or the heartbeat
													dies mid-copy.
												</p>
												<div className="grid grid-cols-2 gap-3">
													<NumberField
														label="Rows per page"
														hint="Bigger is faster on a good link"
														value={importOptions.pageSize}
														min={25}
														max={5000}
														onChange={(pageSize) => updateOptions({ pageSize })}
													/>
													<NumberField
														label="Source connections"
														hint="Keep 1 for kubectl relay"
														value={importOptions.connections}
														min={1}
														max={4}
														onChange={(connections) =>
															updateOptions({ connections })
														}
													/>
													<NumberField
														label="Fetch timeout (sec)"
														value={importOptions.fetchTimeoutSec}
														min={15}
														max={600}
														onChange={(fetchTimeoutSec) =>
															updateOptions({ fetchTimeoutSec })
														}
													/>
													<NumberField
														label="UMAP fit rows"
														hint="Lower is faster to project"
														value={importOptions.umapFitMax}
														min={500}
														max={100000}
														onChange={(umapFitMax) =>
															updateOptions({ umapFitMax })
														}
													/>
												</div>
												<div className="flex items-center justify-between gap-3 text-sm">
													<div>
														<p>Copy full row payload</p>
														<p className="text-xs text-muted-foreground">
															On = change the cluster field after import
														</p>
													</div>
													<Switch
														checked={importOptions.includePayload}
														onCheckedChange={(includePayload) =>
															updateOptions({ includePayload })
														}
													/>
												</div>
												<div className="flex items-center justify-between gap-3 text-sm">
													<div>
														<p>Build HNSW index</p>
														<p className="text-xs text-muted-foreground">
															Skip to finish sooner; neighbors get slower
														</p>
													</div>
													<Switch
														checked={importOptions.buildHnsw}
														onCheckedChange={(buildHnsw) =>
															updateOptions({ buildHnsw })
														}
													/>
												</div>
											</div>
										)}
									</>
								)}
							</>
						)}
					</div>
				)}

				{/* Import progress */}
				{(importing || importDone) && progress && (
					<div className="grid gap-3 py-2">
						<div className="flex items-center justify-between text-sm">
							<span className="flex items-center gap-2">
								{importing && <Loader2 className="size-4 animate-spin" />}
								{progressLabel(progress)}
							</span>
							{progress.done !== undefined && progress.total !== undefined && (
								<span className="font-mono text-xs text-muted-foreground">
									{progress.done.toLocaleString()}
									{progress.total > 0 &&
										` / ${progress.total.toLocaleString()}`}
								</span>
							)}
						</div>
						<Progress value={progressPercent(progress)} />
						{importDone && (
							<Button
								onClick={() => {
									setImportDone(null);
									setProgress(null);
									setOpen(false);
								}}
							>
								Done — {importDone.rows.toLocaleString()} rows imported
							</Button>
						)}
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}

function NumberField({
	label,
	hint,
	value,
	min,
	max,
	onChange,
}: {
	label: string;
	hint?: string;
	value: number;
	min: number;
	max: number;
	onChange: (n: number) => void;
}) {
	return (
		<div className="grid gap-1.5">
			<Label className="text-xs">{label}</Label>
			<Input
				type="number"
				min={min}
				max={max}
				value={value}
				onChange={(e) => {
					const n = Number(e.target.value);
					if (!Number.isFinite(n)) return;
					onChange(Math.min(max, Math.max(min, Math.round(n))));
				}}
			/>
			{hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
		</div>
	);
}

function ColumnSelect({
	label,
	value,
	onChange,
	columns,
	allowNone,
}: {
	label: string;
	value: string;
	onChange: (v: string) => void;
	columns: SourceColumn[];
	allowNone?: boolean;
}) {
	return (
		<div className="grid gap-1.5">
			<Label className="text-xs">{label}</Label>
			<Select
				value={value}
				onValueChange={(v) => onChange(v ?? (allowNone ? NONE : ""))}
			>
			<SelectTrigger className="w-full min-w-0">
				<SelectValue placeholder="—" />
			</SelectTrigger>
				<SelectContent>
					{allowNone && <SelectItem value={NONE}>None</SelectItem>}
				{columns.map((c) => (
					<SelectItem key={c.name} value={c.name}>
						<span className="flex min-w-0 items-center gap-2">
							<span className="truncate">{c.name}</span>
							<span className="shrink-0 text-xs text-muted-foreground">
								{c.udt === "vector" && c.vectorDim
									? `vector(${c.vectorDim})`
									: c.dataType}
							</span>
						</span>
					</SelectItem>
				))}
				</SelectContent>
			</Select>
		</div>
	);
}
