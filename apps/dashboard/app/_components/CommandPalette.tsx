"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { NavigationProgress } from "./NavigationProgress";
import {
  searchWorkspaceAction,
  type WorkspaceSearchHit,
} from "../../lib/workspace-settings-actions";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem as CommandItemPrimitive,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";

export type CommandKind = "navigate" | "action" | "recent";

export interface CommandItem {
  id: string;
  label: string;
  hint?: string;
  section: string;
  glyph?: string;
  keywords?: string[];
  kind: CommandKind;
  to?: string;
  onInvoke?: () => void;
  shortcut?: string;
}

interface CommandPaletteApi {
  open(): void;
  close(): void;
  toggle(): void;
  setItems(items: CommandItem[]): void;
}

const CommandPaletteContext = React.createContext<CommandPaletteApi | null>(null);

export function useCommandPalette(): CommandPaletteApi {
  const ctx = React.useContext(CommandPaletteContext);
  if (!ctx) throw new Error("useCommandPalette must be used inside <CommandPaletteProvider>");
  return ctx;
}

export function CommandPaletteProvider({
  children,
  initialItems,
}: {
  children: React.ReactNode;
  initialItems: CommandItem[];
}) {
  const [open, setOpen] = React.useState(false);
  const [items, setItems] = React.useState<CommandItem[]>(initialItems);
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  // AXE-31 — workspace search-as-you-type. Debounced 180ms so we
  // don't fire one query per keystroke; cancels prior in-flight
  // queries via a ref-tracked "request id".
  const [query, setQuery] = React.useState("");
  const [dynamicItems, setDynamicItems] = React.useState<CommandItem[]>([]);
  const reqIdRef = React.useRef(0);
  React.useEffect(() => {
    const id = ++reqIdRef.current;
    if (query.trim().length < 2) {
      setDynamicItems([]);
      return;
    }
    const timer = setTimeout(() => {
      void searchWorkspaceAction(query)
        .then((hits) => {
          if (id !== reqIdRef.current) return; // stale
          setDynamicItems(hits.map(hitToItem));
        })
        .catch(() => {
          /* swallow — palette stays on static items */
        });
    }, 180);
    return () => clearTimeout(timer);
  }, [query]);

  const api = React.useMemo<CommandPaletteApi>(
    () => ({
      open: () => setOpen(true),
      close: () => setOpen(false),
      toggle: () => setOpen((v) => !v),
      setItems,
    }),
    [],
  );

  React.useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const isCmdK = (e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K");
      if (isCmdK) {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      const editable = tag === "input" || tag === "textarea" || target?.isContentEditable;
      if (e.key === "/" && !editable && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setOpen(true);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  function invoke(item: CommandItem) {
    setOpen(false);
    if (item.to) {
      if (item.to.startsWith("http")) {
        window.open(item.to, "_blank", "noopener,noreferrer");
      } else {
        startTransition(() => router.push(item.to!));
      }
    } else if (item.onInvoke) {
      item.onInvoke();
    }
  }

  const grouped = React.useMemo(() => {
    const map = new Map<string, CommandItem[]>();
    // AXE-31 — dynamic results render first so they're easy to find
    // when the user is typing a specific name.
    for (const item of [...dynamicItems, ...items]) {
      const arr = map.get(item.section) ?? [];
      arr.push(item);
      map.set(item.section, arr);
    }
    return Array.from(map.entries());
  }, [items, dynamicItems]);

  function hitToItem(hit: WorkspaceSearchHit): CommandItem {
    const section =
      hit.kind === "source"
        ? "Sources"
        : hit.kind === "destination"
        ? "Destinations"
        : hit.kind === "route"
        ? "Pipelines"
        : "Dead letters";
    return {
      id: `search:${hit.kind}:${hit.id}`,
      label: hit.label,
      hint: hit.hint,
      section,
      kind: "navigate",
      to: hit.href,
      keywords: [hit.id, hit.kind],
    };
  }

  return (
    <CommandPaletteContext.Provider value={api}>
      <NavigationProgress pending={pending} />
      {children}
      <CommandDialog open={open} onOpenChange={setOpen}>
        <CommandInput
          placeholder="Type to search workspace, navigate, or create..."
          value={query}
          onValueChange={setQuery}
        />
        <CommandList>
          <CommandEmpty>No results.</CommandEmpty>
          {grouped.map(([section, sectionItems], idx) => (
            <React.Fragment key={section}>
              {idx > 0 ? <CommandSeparator /> : null}
              <CommandGroup heading={section}>
                {sectionItems.map((item) => (
                  <CommandItemPrimitive
                    key={item.id}
                    value={`${item.label} ${item.hint ?? ""} ${(item.keywords ?? []).join(" ")}`}
                    onSelect={() => invoke(item)}
                  >
                    <span className="flex flex-1 flex-col">
                      <span>{item.label}</span>
                      {item.hint ? (
                        <span className="text-xs text-muted-foreground">{item.hint}</span>
                      ) : null}
                    </span>
                    {item.shortcut ? <CommandShortcut>{item.shortcut}</CommandShortcut> : null}
                  </CommandItemPrimitive>
                ))}
              </CommandGroup>
            </React.Fragment>
          ))}
        </CommandList>
      </CommandDialog>
    </CommandPaletteContext.Provider>
  );
}
