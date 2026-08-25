"use client";

import { Settings2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Slider } from "@/components/ui/slider";
import { useVectorStore } from "@/lib/store";

export function SettingsPopover() {
  const pointSize = useVectorStore((s) => s.pointSize);
  const setPointSize = useVectorStore((s) => s.setPointSize);
  const sample = useVectorStore((s) => s.sample);
  const setSample = useVectorStore((s) => s.setSample);
  const totalCount = useVectorStore((s) => s.totalCount);

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="icon"
            className="pointer-events-auto border-white/10 bg-black/40 backdrop-blur-md hover:bg-black/60"
          >
            <Settings2 className="size-4" />
          </Button>
        }
      />
      <PopoverContent align="end" className="w-72">
        <div className="grid gap-5">
          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <Label>Point size</Label>
              <span className="font-mono text-xs text-muted-foreground">
                {pointSize.toFixed(1)}x
              </span>
            </div>
            <Slider
              value={[pointSize]}
              onValueChange={(v) => setPointSize(typeof v === "number" ? v : (v[0] ?? 1))}
              min={0.2}
              max={4}
              step={0.1}
            />
          </div>
          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <Label>Sample rate</Label>
              <span className="font-mono text-xs text-muted-foreground">
                {(sample * 100).toFixed(0)}%
                {totalCount > 0 && ` · ~${Math.round(totalCount * sample).toLocaleString()} pts`}
              </span>
            </div>
            <Slider
              value={[sample]}
              onValueChange={(v) => setSample(typeof v === "number" ? v : (v[0] ?? 1))}
              min={0.01}
              max={1}
              step={0.01}
            />
            <p className="text-xs text-muted-foreground">
              Lower sampling keeps interaction smooth on very large tables. The subset is stable
              (hash-based), so points don&apos;t flicker between reloads.
            </p>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
