"use client";

import { KeyRound, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useVectorStore } from "@/lib/store";
import { setGatewayToken } from "@/lib/token";

export function TokenDialog() {
  const open = useVectorStore((s) => s.tokenDialogOpen);
  const setOpen = useVectorStore((s) => s.setTokenDialogOpen);
  const token = useVectorStore((s) => s.token);
  const setToken = useVectorStore((s) => s.setToken);
  const [value, setValue] = useState("");

  const save = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    setGatewayToken(trimmed);
    setToken(trimmed);
    setValue("");
    setOpen(false);
    toast.success("Gateway token saved — semantic search is enabled.");
  };

  const clear = () => {
    setGatewayToken(null);
    setToken(null);
    setOpen(false);
    toast.info("Gateway token removed — search disabled.");
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="size-4" />
            Vercel AI Gateway token
          </DialogTitle>
          <DialogDescription>
            Semantic search embeds your query through the Vercel AI Gateway. Paste a
            gateway token to enable it. The token is stored only in your
            browser&apos;s localStorage and sent with search requests.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2 py-2">
          <Label htmlFor="gateway-token">Token</Label>
          <Input
            id="gateway-token"
            type="password"
            placeholder="vck_..."
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && save()}
            autoComplete="off"
          />
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="ghost" onClick={clear} disabled={!token}>
            <Trash2 className="size-4" />
            Remove saved token
          </Button>
          <Button onClick={save} disabled={!value.trim()}>
            Save token
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
