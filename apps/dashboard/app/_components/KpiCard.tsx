import Link from "@/app/_components/NavigationLink";
import * as React from "react";
import { TrendingUp, TrendingDown } from "lucide-react";
import { cn } from "@/lib/utils";

export interface KpiCardProps {
  label: string;
  /** Full value, e.g. "1,821,476". Shown when the card has room. */
  value: string;
  /**
   * Compact value, e.g. "1.82M". Shown when the card is narrower than
   * the threshold. Defaults to `value` when omitted (so short values
   * like "5" or "99.9%" don't have to specify both).
   */
  compactValue?: string;
  sub?: string;
  deltaPct?: number | null;
  inverse?: boolean;
  href?: string;
}

export function KpiCard({
  label,
  value,
  compactValue,
  sub,
  deltaPct,
  inverse = false,
  href,
}: KpiCardProps) {
  const Wrapper: React.ElementType = href ? Link : "div";
  const wrapperProps = href ? { href } : {};
  const compact = compactValue ?? value;
  const showSwap = compactValue !== undefined && compactValue !== value;

  return (
    <Wrapper
      {...wrapperProps}
      data-dashboard-primary-metric-action={href ? "ready" : undefined}
      className={cn(
        "@container flex flex-col gap-2 rounded-xl border border-border bg-card p-5 transition-colors",
        href && "hover:border-foreground/20 hover:bg-accent/30",
      )}
    >
      <p className="text-xs font-medium text-muted-foreground">
        {label}
      </p>
      <strong
        className="font-mono text-4xl font-semibold tracking-tight text-foreground"
        title={showSwap ? value : undefined}
      >
        {showSwap ? (
          <>
            {/* Container queries: full value at >= 11rem (176px) of card
                width — comfortably fits 9 mono chars at text-4xl —
                otherwise fall back to the compact form. */}
            <span className="hidden @[11rem]:inline">{value}</span>
            <span className="inline @[11rem]:hidden">{compact}</span>
          </>
        ) : (
          value
        )}
      </strong>
      <div className="mt-1 flex min-h-[20px] items-center gap-2 text-xs">
        {deltaPct === null || deltaPct === undefined ? (
          sub ? <span className="text-muted-foreground">{sub}</span> : null
        ) : (
          <DeltaPill pct={deltaPct} inverse={inverse} />
        )}
      </div>
    </Wrapper>
  );
}

function DeltaPill({ pct, inverse }: { pct: number; inverse: boolean }) {
  if (pct === 0) {
    return (
      <span className="inline-flex items-center gap-0.5 rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
        0%
      </span>
    );
  }
  const up = pct > 0;
  const positive = inverse ? !up : up;
  const Icon = up ? TrendingUp : TrendingDown;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[11px] font-medium",
        positive
          ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
          : "bg-rose-500/10 text-rose-600 dark:text-rose-400",
      )}
    >
      <Icon className="size-3" />
      {up ? "+" : ""}
      {pct}%
    </span>
  );
}
