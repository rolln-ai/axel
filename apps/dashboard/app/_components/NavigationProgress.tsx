import { LoaderCircle } from "lucide-react";

/** Visible feedback shared by route fallbacks and client navigation transitions. */
export function NavigationProgress({
  pending = true,
  label = "Loading page…",
}: {
  pending?: boolean;
  label?: string;
}) {
  if (!pending) return null;
  return (
    <span role="status" data-navigation-progress="loading" className="pointer-events-none fixed inset-x-0 top-0 z-[70]">
      <span className="block h-0.5 overflow-hidden bg-primary/15" aria-hidden="true">
        <span className="navigation-progress-bar block h-full w-1/3 bg-primary" />
      </span>
      <span className="absolute right-4 top-3 inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-xs font-medium text-foreground shadow-sm">
        <LoaderCircle className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
        {label}
      </span>
    </span>
  );
}
