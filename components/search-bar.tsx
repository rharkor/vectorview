"use client";

import { Hash, Loader2, Lock, Search, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useVectorStore } from "@/lib/store";
import type { SearchResult } from "@/lib/types";

type SearchMode = "embedding" | "id";

export function SearchBar() {
  const token = useVectorStore((s) => s.token);
  const setTokenDialogOpen = useVectorStore((s) => s.setTokenDialogOpen);
  const setSearchResults = useVectorStore((s) => s.setSearchResults);
  const clearSearch = useVectorStore((s) => s.clearSearch);
  const searchResults = useVectorStore((s) => s.searchResults);
  const searchQuery = useVectorStore((s) => s.searchQuery);
  const flyTo = useVectorStore((s) => s.flyTo);
  const selectPoint = useVectorStore((s) => s.selectPoint);

  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [mode, setMode] = useState<SearchMode>("id");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (mode === "embedding" && !token) setTokenDialogOpen(true);
        else inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [token, mode, setTokenDialogOpen]);

  const runSearch = async () => {
    const q = query.trim();
    if (!q) return;
    if (mode === "embedding" && !token) {
      setTokenDialogOpen(true);
      return;
    }
    setSearching(true);
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ query: q, k: 20, mode }),
      });
      const body = (await res.json()) as {
        results?: SearchResult[];
        error?: string;
      };
      if (!res.ok) {
        if (res.status === 401) setTokenDialogOpen(true);
        toast.error(body.error ?? "Search failed");
        return;
      }
      const results = body.results ?? [];
      setSearchResults(results, q);
      if (results.length === 0) {
        toast.info("No results found");
        return;
      }
      const top = results[0];
      if (typeof top.x === "number" && typeof top.y === "number") {
        const pos: [number, number, number] = [top.x, top.y, (top.z as number) ?? 0];
        flyTo(...pos);
        selectPoint(String(top.source_id ?? top.id), pos);
      }
      toast.success(`${results.length} matches for "${q}"`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Search failed");
    } finally {
      setSearching(false);
    }
  };

  const clear = () => {
    setQuery("");
    clearSearch();
  };

  return (
    <div className="pointer-events-auto relative flex h-11 w-full items-center gap-1.5 rounded-full border border-white/10 bg-black/40 px-2 backdrop-blur-md focus-within:border-white/30">
      <div className="flex shrink-0 rounded-full bg-black/40 p-0.5">
        <button
          type="button"
          onClick={() => setMode("id")}
          className={`flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-medium uppercase ${
            mode === "id"
              ? "bg-sky-500/80 text-white"
              : "text-muted-foreground hover:text-foreground"
          }`}
          title="Match source id or label"
        >
          <Hash className="size-3" />
          ID
        </button>
        <button
          type="button"
          onClick={() => {
            if (!token) setTokenDialogOpen(true);
            setMode("embedding");
          }}
          className={`flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-medium uppercase ${
            mode === "embedding"
              ? "bg-fuchsia-400 text-zinc-950"
              : "text-muted-foreground hover:text-foreground"
          }`}
          title="Semantic search via embeddings"
        >
          <Sparkles className="size-3" />
          AI
        </button>
      </div>
      {searching ? (
        <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
      ) : mode === "embedding" && !token ? (
        <Lock className="size-4 shrink-0 text-muted-foreground" />
      ) : (
        <Search className="size-4 shrink-0 text-muted-foreground" />
      )}
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") runSearch();
          if (e.key === "Escape") {
            clear();
            inputRef.current?.blur();
          }
        }}
        placeholder={
          mode === "id"
            ? "Find a point by id or label…"
            : token
              ? "Semantic search across embeddings…"
              : "Add a gateway token for AI search"
        }
        className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
      />
      {searchResults.length > 0 && (
        <Badge variant="secondary" className="shrink-0">
          {searchResults.length} hits · {searchQuery}
        </Badge>
      )}
      {(query || searchResults.length > 0) && (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={clear}
          className="shrink-0 text-muted-foreground"
        >
          <X className="size-4" />
        </Button>
      )}
    </div>
  );
}
