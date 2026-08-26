import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Card-style page section with a bordered title header and an optional pill.
 * String pills render as an outline <Badge>; a ReactNode pill renders as-is.
 * Previously copied verbatim into five detail pages.
 */
export function Section({
  id,
  title,
  pill,
  className,
  children,
}: {
  id?: string;
  title: string;
  pill?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className={cn("mt-6 rounded-lg border border-border bg-card", className)}>
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {typeof pill === "string" ? (
          pill ? <Badge variant="outline">{pill}</Badge> : null
        ) : (
          pill ?? null
        )}
      </div>
      <div className="space-y-3 p-5">{children}</div>
    </section>
  );
}
