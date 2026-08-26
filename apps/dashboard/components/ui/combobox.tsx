"use client";

import * as React from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { ChevronsUpDownIcon, PlusIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

/**
 * Themed, searchable single-select combobox — the app's Popover + Command
 * pattern, so it matches Select instead of the browser-native <datalist>.
 * With `allowCustom`, a typed value that matches no option surfaces a
 * "Create …" row (used for target names the connector creates on demand).
 */
export function Combobox({
  id,
  value,
  onChange,
  options,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  emptyText = "No matches.",
  createLabel = (v) => `Create “${v}”`,
  allowCustom = false,
  disabled = false,
  loading = false,
  className,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: React.ReactNode;
  createLabel?: (value: string) => React.ReactNode;
  allowCustom?: boolean;
  disabled?: boolean;
  loading?: boolean;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");

  const trimmed = search.trim();
  const isNew =
    allowCustom &&
    trimmed.length > 0 &&
    !options.some((o) => o.toLowerCase() === trimmed.toLowerCase());

  function commit(next: string) {
    onChange(next);
    setSearch("");
    setOpen(false);
  }

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          id={id}
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            "flex h-9 w-full items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent px-3 py-2 text-left font-mono text-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30 dark:hover:bg-input/50",
            !value && "font-sans text-muted-foreground",
            className,
          )}
        >
          <span className="truncate">{value || placeholder}</span>
          <ChevronsUpDownIcon className="size-4 shrink-0 opacity-50" />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={4}
          className="z-50 w-(--radix-popover-trigger-width) origin-(--radix-popover-content-transform-origin) overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
        >
          <Command
            // Substring match; the "create" row carries the raw search as its
            // value so it always survives the filter.
            filter={(itemValue, query) =>
              itemValue.toLowerCase().includes(query.toLowerCase()) ? 1 : 0
            }
          >
            <CommandInput
              placeholder={searchPlaceholder}
              value={search}
              onValueChange={setSearch}
            />
            <CommandList>
              <CommandEmpty>{loading ? "Loading…" : emptyText}</CommandEmpty>
              <CommandGroup>
                {options.map((option) => (
                  <CommandItem
                    key={option}
                    value={option}
                    data-checked={option === value ? "true" : undefined}
                    onSelect={() => commit(option)}
                  >
                    <span className="truncate font-mono text-xs">{option}</span>
                  </CommandItem>
                ))}
                {isNew ? (
                  <CommandItem value={trimmed} onSelect={() => commit(trimmed)}>
                    <PlusIcon />
                    <span className="truncate">{createLabel(trimmed)}</span>
                  </CommandItem>
                ) : null}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
