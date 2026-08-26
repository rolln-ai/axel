"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Vercel-style left sidenav for resource-detail pages.
 *
 * Renders inside the app's main left sidebar (AppNav swaps to this when
 * the pathname matches a detail-page pattern). The back link + section
 * list let users move around a resource without losing focus on it.
 *
 * One section can match the bare resource URL (`exact: true`), which is
 * useful for the implicit "Overview" subpage where `/destinations/[id]`
 * IS the overview rather than redirecting to `/destinations/[id]/overview`.
 */

export interface DetailSubnavSection {
  href: string;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  /**
   * When set, only consider this section active for an exact pathname
   * match (not a startsWith). Required for the bare-URL section so
   * deeper paths like `/destinations/[id]/credential` don't double-light
   * the overview link.
   */
  exact?: boolean;
  /** Optional muted hint shown after the label (e.g. "2 stale"). */
  hint?: string;
}

export function DetailSubnav({
  backHref,
  backLabel,
  resourceLabel,
  sections,
}: {
  backHref: string;
  backLabel: string;
  /** Shown beneath the back link as a small caption. e.g. "Destination". */
  resourceLabel: string;
  sections: DetailSubnavSection[];
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const currentTab = searchParams.get("tab");
  return (
    <nav aria-label={resourceLabel} data-dashboard-nav="ready" className="flex flex-col gap-3 py-2">
      <Link
        href={backHref}
        prefetch={false}
        className="inline-flex items-center gap-1.5 px-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3" />
        {backLabel}
      </Link>
      <p className="px-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {resourceLabel}
      </p>
      <ul className="flex flex-col gap-px">
        {sections.map((section) => {
          const active = isSectionActive(pathname, currentTab, section);
          const Icon = section.Icon;
          return (
            <li key={section.href}>
              <Link
                href={section.href}
                aria-current={active ? "page" : undefined}
                prefetch={false}
                className={cn(
                  "group flex h-7 items-center gap-2 rounded-md px-2 text-sm transition-colors",
                  active
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
              >
                <Icon className={cn("size-4 shrink-0", active && "text-primary")} />
                <span className="flex-1 truncate">{section.label}</span>
                {section.hint ? (
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {section.hint}
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function isSectionActive(
  pathname: string | null,
  currentTab: string | null,
  section: DetailSubnavSection,
): boolean {
  if (!pathname) return false;
  // Split href into pathname + query so we can match each part.
  const [hrefPath, hrefQuery] = section.href.split("?");
  if (!hrefPath) return false;

  if (hrefQuery) {
    // Query-param-based section (e.g. /sources/abc?tab=contract).
    // Active only when pathname matches AND query tab matches.
    if (hrefPath !== pathname) return false;
    const expected = new URLSearchParams(hrefQuery).get("tab");
    return expected === currentTab;
  }

  if (section.exact) {
    // Bare-URL overview entry — active only on exact pathname match
    // AND no `tab` query (so /sources/abc?tab=contract doesn't double-
    // light Overview).
    return pathname === hrefPath && currentTab === null;
  }

  // Non-exact path section: active if pathname matches or is a deeper child.
  return pathname === hrefPath || pathname.startsWith(`${hrefPath}/`);
}
