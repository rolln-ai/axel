"use client";

import * as React from "react";
import { Search } from "lucide-react";
import { useCommandPalette } from "./CommandPalette";

export function CommandPaletteHint() {
  const palette = useCommandPalette();
  const [isMac, setIsMac] = React.useState(true);

  React.useEffect(() => {
    if (typeof navigator !== "undefined") {
      setIsMac(/Mac|iPhone|iPad/.test(navigator.platform));
    }
  }, []);

  return (
    <button
      type="button"
      onClick={() => palette.open()}
      aria-label="Open command palette"
      className="flex w-full items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-left text-sm text-muted-foreground transition hover:border-foreground/20 hover:text-foreground"
    >
      <Search className="size-4" />
      <span className="flex-1">Search</span>
      <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
        {isMac ? "⌘" : "Ctrl"}K
      </kbd>
    </button>
  );
}
