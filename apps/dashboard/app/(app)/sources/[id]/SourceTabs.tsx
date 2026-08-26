import Link from "next/link";
import { cn } from "@/lib/utils";

export type SourceTabKey = "overview" | "contract" | "ingest" | "sync" | "settings";

export interface SourceTab {
  key: SourceTabKey;
  label: string;
  /** Optional small count/indicator rendered to the right of the label. */
  hint?: string;
  intent?: "default" | "warning";
}

/**
 * URL-driven tab bar for the source detail page. Pure server component:
 * the active tab is determined by `?tab=...` in the page's searchParams
 * and the bar renders a row of <Link replace> elements, so deep-linking
 * and browser back/forward both work without client state.
 */
export function SourceTabs({
  sourceId,
  active,
  tabs,
}: {
  sourceId: string;
  active: SourceTabKey;
  tabs: SourceTab[];
}) {
  return (
    <nav className="mb-6 border-b border-border" aria-label="Source sections">
      <ul className="flex flex-wrap gap-1 -mb-px">
        {tabs.map((tab) => {
          const isActive = tab.key === active;
          return (
            <li key={tab.key}>
              <Link
                href={`/sources/${sourceId}?tab=${tab.key}`}
                replace
                scroll={false}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm transition-colors",
                  isActive
                    ? "border-foreground text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {tab.label}
                {tab.hint ? (
                  <span
                    className={cn(
                      "rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                      tab.intent === "warning"
                        ? "bg-destructive/15 text-destructive"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    {tab.hint}
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
