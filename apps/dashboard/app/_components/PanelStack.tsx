"use client";

import * as React from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface PanelDescriptor {
  id: string;
  eyebrow?: string;
  title: string;
  body: React.ReactNode;
  footer?: React.ReactNode;
  /** When true, render with the narrower secondary-panel width. */
  secondary?: boolean;
}

export interface PanelStackHandle {
  push: (panel: PanelDescriptor) => void;
  pop: () => boolean;
  close: () => void;
  replaceTop: (panel: PanelDescriptor) => void;
  depth: () => number;
}

const PanelStackContext = React.createContext<PanelStackHandle | null>(null);

export function usePanelStack(): PanelStackHandle {
  const ctx = React.useContext(PanelStackContext);
  if (!ctx) {
    throw new Error(
      "usePanelStack must be used inside a <PanelStackProvider> tree.",
    );
  }
  return ctx;
}

export function PanelStackProvider({ children }: { children: React.ReactNode }) {
  const [panels, setPanels] = React.useState<PanelDescriptor[]>([]);

  const handle = React.useMemo<PanelStackHandle>(
    () => ({
      push: (panel) => setPanels((current) => [...current, panel]),
      pop: () => {
        let popped = false;
        setPanels((current) => {
          if (current.length === 0) return current;
          popped = true;
          return current.slice(0, -1);
        });
        return popped;
      },
      close: () => setPanels([]),
      replaceTop: (panel) =>
        setPanels((current) =>
          current.length === 0 ? [panel] : [...current.slice(0, -1), panel],
        ),
      depth: () => panels.length,
    }),
    [panels.length],
  );

  React.useEffect(() => {
    if (panels.length === 0) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        handle.pop();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [panels.length, handle]);

  React.useEffect(() => {
    if (panels.length === 0) return;
    const original = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = original;
    };
  }, [panels.length]);

  return (
    <PanelStackContext.Provider value={handle}>
      {children}
      {panels.length > 0 ? (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm animate-in fade-in"
            onClick={() => handle.close()}
            aria-hidden="true"
          />
          {panels.map((panel, idx) => {
            const isTop = idx === panels.length - 1;
            const offsetFromRight = panels.length - 1 - idx;
            const isNarrow = panel.secondary || !isTop;
            return (
              <div
                key={panel.id}
                className={cn(
                  "absolute top-0 bottom-0 flex flex-col border-l border-border bg-background shadow-xl animate-in slide-in-from-right",
                  isNarrow ? "w-[420px]" : "w-[560px]",
                )}
                style={{ right: offsetFromRight * 60 }}
                role="dialog"
                aria-modal={isTop}
                aria-label={panel.title}
              >
                <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    {panel.eyebrow ? (
                      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                        {panel.eyebrow}
                      </p>
                    ) : null}
                    <h2 className="truncate text-base font-semibold text-foreground">{panel.title}</h2>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7 shrink-0"
                    aria-label="Close panel"
                    onClick={() => {
                      setPanels((current) => current.slice(0, idx));
                    }}
                  >
                    <X className="size-4" />
                  </Button>
                </div>
                <div className="flex-1 overflow-y-auto px-5 py-4">{panel.body}</div>
                {panel.footer ? (
                  <div className="flex items-center justify-end gap-2 border-t border-border bg-muted/30 px-5 py-3">
                    {panel.footer}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </PanelStackContext.Provider>
  );
}
