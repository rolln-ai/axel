import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getDestinationSummary } from "../../../../lib/destination-inspect";
import { requireSession } from "../../../../lib/session";
import { EntityStatusBadge } from "../../../_components/StatusBadges";

export const dynamic = "force-dynamic";

/**
 * Shared chrome for the destination detail subpages.
 *
 * The sidenav itself lives in AppNav (it swaps to the destination
 * subnav based on the pathname). This layout only renders the page
 * header (back link + name + status pills) so every subsection has
 * the same context up top.
 */
export default async function DestinationDetailLayout({
  params,
  children,
}: {
  params: Promise<{ id: string }>;
  children: React.ReactNode;
}) {
  const { id } = await params;
  const session = await requireSession();
  const destination = await getDestinationSummary(id, session.activeWorkspace.workspace_id);
  if (!destination) notFound();

  return (
    <>
      <div className="mb-6 flex items-end justify-between gap-4 border-b border-border pb-5">
        <div className="flex flex-col gap-1 min-w-0">
          <Link
            href="/destinations"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-3" />
            All destinations
          </Link>
          <h1 className="truncate text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
            {destination.name}
          </h1>
          <small className="font-mono text-xs text-muted-foreground">{destination.id}</small>
        </div>
        <div className="flex flex-col items-end gap-1">
          {/* The status column only reflects the manual enable/disable
              toggle. The delivery path can halt a destination three other
              ways (operator pause, 429 retry-after window, circuit
              breaker) — each must be visible here, or the header claims
              "Active" while nothing is being delivered (ROL-628). */}
          <EntityStatusBadge status={destination.status} className="capitalize" />
          {destination.delivery_paused ? (
            <span
              className="rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-600 dark:text-red-400"
              title={destination.delivery_paused_reason ?? "Delivery paused by an operator"}
            >
              delivery paused
            </span>
          ) : null}
          {destination.retry_after_until && Date.parse(destination.retry_after_until) > Date.now() ? (
            <span
              className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400"
              title="The destination answered 429; deliveries are held until its Retry-After window ends"
            >
              backing off (429)
            </span>
          ) : null}
          {destination.circuit_state !== "closed" ? (
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                destination.circuit_state === "open"
                  ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                  : destination.circuit_state === "half_open"
                  ? "bg-blue-500/15 text-blue-600 dark:text-blue-400"
                  : "bg-red-500/15 text-red-600 dark:text-red-400"
              }`}
              title={
                destination.circuit_state === "disabled"
                  ? "The breaker is disabled: every delivery is being dead-lettered"
                  : "Circuit breaker state"
              }
            >
              {destination.circuit_state === "open"
                ? "paused: breaker open"
                : destination.circuit_state === "half_open"
                ? "probing recovery"
                : "breaker disabled — dead-lettering"}
            </span>
          ) : null}
        </div>
      </div>
      {children}
    </>
  );
}
