import * as React from "react";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Loading placeholder with the EXACT same box model as `PageHeader` (mb-8,
 * pb-6, no bottom border, h1 = text-3xl/md:text-4xl ≈ h-9/h-10). Use this in
 * every `loading.tsx` so the header geometry can't drift from the real page and
 * shift the body on resolve. Pass `actions` to reserve the action row.
 */
export function PageHeaderSkeleton({
  eyebrow = true,
  description = true,
  actions,
}: {
  eyebrow?: boolean;
  description?: boolean;
  actions?: React.ReactNode;
}) {
  return (
    <header className="mb-8 flex flex-col gap-4 pb-6 md:flex-row md:items-end md:justify-between md:gap-6">
      <div className="flex min-w-0 flex-col gap-1.5">
        {eyebrow ? <Skeleton className="h-3 w-24" /> : null}
        <Skeleton className="h-9 w-56 max-w-full md:h-10" />
        {description ? <Skeleton className="h-4 w-72 max-w-full" /> : null}
      </div>
      {actions ? (
        <div className="grid grid-cols-2 gap-2 [&>*]:w-full md:flex md:w-auto md:shrink-0 md:flex-wrap md:items-center md:justify-end [&>*]:md:w-auto">
          {actions}
        </div>
      ) : null}
    </header>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <header className="mb-8 flex flex-col gap-4 pb-6 md:flex-row md:items-end md:justify-between md:gap-6">
      <div className="flex min-w-0 flex-col gap-1.5">
        {eyebrow ? (
          <p className="text-xs text-muted-foreground">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="text-3xl font-semibold tracking-tight text-foreground md:text-4xl">
          {title}
        </h1>
        {description ? (
          <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? (
        // Mobile: 2-column grid where each action stretches to fill, so 4 CTA
        // buttons (e.g. New source / destination / route + See full usage on
        // /dashboard) lay out evenly in a 2×2 instead of wrapping with the
        // primary "New route" stranded on its own row. md+: revert to the
        // existing right-aligned wrap.
        <div className="grid grid-cols-2 gap-2 [&>*]:w-full md:flex md:w-auto md:shrink-0 md:flex-wrap md:items-center md:justify-end [&>*]:md:w-auto">
          {actions}
        </div>
      ) : null}
    </header>
  );
}
