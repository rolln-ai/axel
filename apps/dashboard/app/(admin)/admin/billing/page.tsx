import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "../../../_components/PageHeader";
import { requireSuperAdmin } from "../../../../lib/admin-auth";
import {
  getBillingOverviewTotals,
  listAdminBillingWorkspaces,
  type AdminBillingWorkspaceRow,
  type ListAdminBillingOptions,
} from "../../../../lib/admin-billing";

export const dynamic = "force-dynamic";

interface AdminBillingPageProps {
  searchParams: Promise<{
    status?: string;
    plan?: string;
    q?: string;
  }>;
}

export default async function AdminBillingPage({ searchParams }: AdminBillingPageProps) {
  await requireSuperAdmin();
  const params = await searchParams;
  const status = normalizeStatus(params.status);
  const plan = normalizePlan(params.plan);
  const search = params.q?.trim() || undefined;

  const opts: ListAdminBillingOptions = { status, plan, search };
  const [totals, workspaces] = await Promise.all([
    getBillingOverviewTotals().catch(() => null),
    listAdminBillingWorkspaces(opts),
  ]);

  return (
    <>
      <PageHeader
        eyebrow="Admin"
        title="Billing"
        description="Plan, status, and current-period usage for every active workspace."
      />

      {totals ? (
        <section className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Tile label="MRR (est.)" value={`$${(totals.mrrCentsEstimate / 100).toFixed(2)}`} />
          <Tile label="Active Pro" value={String(totals.activeProCount)} />
          <Tile
            label="Need attention"
            value={String(totals.attentionCount)}
            accent={totals.attentionCount > 0 ? "past_due / suspended / grace" : undefined}
          />
          <Tile
            label="Free over cap"
            value={String(totals.freeWorkspacesOverCap)}
            accent={totals.freeWorkspacesOverCap > 0 ? "currently 429'd" : undefined}
          />
        </section>
      ) : null}

      <section className="mb-4 flex flex-wrap items-center gap-3 text-sm">
        <FilterLink label="All" href="/admin/billing" active={!status && !plan && !search} />
        <FilterLink label="Pro" href="/admin/billing?plan=pro" active={plan === "pro"} />
        <FilterLink label="Free" href="/admin/billing?plan=free" active={plan === "free"} />
        <FilterLink label="Past due" href="/admin/billing?status=past_due" active={status === "past_due"} />
        <FilterLink label="Suspended" href="/admin/billing?status=suspended" active={status === "suspended"} />
        <FilterLink label="Grace" href="/admin/billing?status=grace" active={status === "grace"} />
      </section>

      <section className="rounded-lg border border-border bg-card">
        <table className="w-full text-sm">
          <thead className="border-b border-border bg-muted/30 text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-2 text-left">Workspace</th>
              <th className="px-4 py-2 text-left">Plan</th>
              <th className="px-4 py-2 text-left">Status</th>
              <th className="px-4 py-2 text-right">Tasks</th>
              <th className="px-4 py-2 text-right">Next invoice</th>
              <th className="px-4 py-2 text-left">Owner</th>
            </tr>
          </thead>
          <tbody>
            {workspaces.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-muted-foreground">
                  No workspaces match this filter.
                </td>
              </tr>
            ) : (
              workspaces.map((row) => <Row key={row.workspace_id} row={row} />)
            )}
          </tbody>
        </table>
      </section>

      <section className="mt-6 text-xs text-muted-foreground">
        <Link href="/admin/billing/webhooks" className="text-primary underline-offset-2 hover:underline">
          Stripe webhook journal →
        </Link>
      </section>
    </>
  );
}

function Row({ row }: { row: AdminBillingWorkspaceRow }) {
  const statusVariant: Record<typeof row.billing_status, "secondary" | "destructive" | "outline" | "default"> = {
    ok: "secondary",
    grace: "outline",
    past_due: "destructive",
    suspended: "destructive",
    canceled: "outline",
  };
  return (
    <tr className="border-b border-border last:border-b-0 hover:bg-muted/10">
      <td className="px-4 py-2.5">
        <Link
          href={`/admin/billing/${row.workspace_id}`}
          className="font-medium text-foreground hover:underline"
        >
          {row.workspace_name}
        </Link>
        <span className="ml-2 font-mono text-[11px] text-muted-foreground">{row.workspace_id}</span>
      </td>
      <td className="px-4 py-2.5">
        <Badge className="capitalize" variant={row.plan === "pro" ? "default" : "outline"}>
          {row.plan}
        </Badge>
      </td>
      <td className="px-4 py-2.5">
        <Badge variant={statusVariant[row.billing_status]}>{row.billing_status.replace("_", " ")}</Badge>
      </td>
      <td className="px-4 py-2.5 text-right font-mono">{row.total_tasks.toLocaleString()}</td>
      <td className="px-4 py-2.5 text-right font-mono">
        {row.plan === "free" ? "—" : `$${(row.estimated_next_invoice_cents / 100).toFixed(2)}`}
      </td>
      <td className="px-4 py-2.5 text-muted-foreground">{row.owner_email ?? "—"}</td>
    </tr>
  );
}

function Tile({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-foreground">{value}</p>
      {accent ? <p className="mt-0.5 text-[11px] text-muted-foreground">{accent}</p> : null}
    </div>
  );
}

function FilterLink({ label, href, active }: { label: string; href: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={
        active
          ? "rounded border border-primary bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary"
          : "rounded border border-border bg-card px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted/40"
      }
    >
      {label}
    </Link>
  );
}

function normalizeStatus(raw: string | undefined): ListAdminBillingOptions["status"] {
  if (raw === "ok" || raw === "past_due" || raw === "grace" || raw === "suspended" || raw === "canceled") {
    return raw;
  }
  return undefined;
}

function normalizePlan(raw: string | undefined): ListAdminBillingOptions["plan"] {
  if (raw === "free" || raw === "pro" || raw === "enterprise") return raw;
  return undefined;
}
