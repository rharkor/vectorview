"use client";

import { Loader2, Lock, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useVectorStore } from "@/lib/store";
import type { SearchResult } from "@/lib/types";

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
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (token) inputRef.current?.focus();
        else setTokenDialogOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [token, setTokenDialogOpen]);

  const runSearch = async () => {
    const q = query.trim();
    if (!q || !token) return;
    setSearching(true);
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ query: q, k: 20 }),
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

  if (!token) {
    return (
      <button
        onClick={() => setTokenDialogOpen(true)}
        className="pointer-events-auto flex h-11 w-full items-center gap-3 rounded-full border border-white/10 bg-black/40 px-4 text-sm text-muted-foreground backdrop-blur-md transition-colors hover:border-white/25 hover:text-foreground"
      >
        <Lock className="size-4 shrink-0" />
        <span>Add a gateway token to enable semantic search</span>
        <kbd className="ml-auto hidden rounded border border-white/15 px-1.5 text-[10px] sm:inline">
          ⌘K
        </kbd>
      </button>
    );
  }

  return (
    <div className="pointer-events-auto relative flex h-11 w-full items-center gap-2 rounded-full border border-white/10 bg-black/40 px-4 backdrop-blur-md focus-within:border-white/30">
      {searching ? (
        <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
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
        placeholder="Semantic search across embeddings…"
        className="h-full w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
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
