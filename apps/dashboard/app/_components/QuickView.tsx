"use client";

import Link from "@/app/_components/NavigationLink";
import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { usePanelStack } from "./PanelStack";
import { Button } from "@/components/ui/button";

/**
 * Shared primitives for the per-row "Quick view" side panels on the
 * sources / destinations / routes list pages. The trigger button, panel
 * chrome, and "Open full page" footer were previously copied per entity —
 * only the panel body stays entity-specific.
 */
export function QuickViewTrigger({
  idPrefix,
  entityId,
  eyebrow,
  title,
  href,
  children,
}: {
  /** Panel-stack id prefix, e.g. "src" → panel id "src:<entityId>". */
  idPrefix: string;
  entityId: string;
  eyebrow: string;
  title: string;
  /** Full detail page linked from the panel footer. */
  href: string;
  /** Panel body. */
  children: ReactNode;
}) {
  const stack = usePanelStack();

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-7 text-xs"
      onClick={(e) => {
        e.stopPropagation();
        stack.push({
          id: `${idPrefix}:${entityId}`,
          eyebrow,
          title,
          body: children,
          footer: (
            <Button variant="outline" size="sm" asChild>
              <Link href={href}>
                Open full page
                <ArrowRight className="ml-1 size-3.5" />
              </Link>
            </Button>
          ),
        });
      }}
    >
      Quick view
    </Button>
  );
}

/** Definition-list grid used for the meta rows at the top of a quick view. */
export function QuickViewMeta({ children }: { children: ReactNode }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-sm">{children}</dl>
  );
}

export function QuickViewMetaItem({
  label,
  className,
  children,
}: {
  label: ReactNode;
  /** Classes for the <dd>. */
  className?: string;
  children: ReactNode;
}) {
  return (
    <>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={className}>{children}</dd>
    </>
  );
}
