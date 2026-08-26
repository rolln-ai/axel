import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "../../../../_components/PageHeader";
import { requireSuperAdmin } from "../../../../../lib/admin-auth";
import {
  listAdminBillingWorkspaces,
  listWorkspaceInvoices,
} from "../../../../../lib/admin-billing";
import { db } from "../../../../../lib/db";

export const dynamic = "force-dynamic";

interface AdminWorkspaceBillingPageProps {
  params: Promise<{ workspaceId: string }>;
}

export default async function AdminWorkspaceBillingPage({
  params,
}: AdminWorkspaceBillingPageProps) {
  await requireSuperAdmin();
  const { workspaceId } = await params;

  // Reuse the list builder so single-workspace pages match the row
  // shape rendered in /admin/billing. One-row LIMIT via the search
  // filter on workspace_id.
  const [workspaces, invoices, recentEvents] = await Promise.all([
    listAdminBillingWorkspaces({ search: workspaceId }),
    listWorkspaceInvoices(workspaceId, 25),
    listRecentBillingEventsForWorkspace(workspaceId),
  ]);
  const ws = workspaces.find((w) => w.workspace_id === workspaceId);
  if (!ws) notFound();

  return (
    <>
      <PageHeader
        eyebrow="Admin / Billing"
        title={ws.workspace_name}
        description={ws.workspace_id}
      />
      <p className="mb-4 text-xs">
        <Link href="/admin/billing" className="text-primary hover:underline">
          ← Back to billing list
        </Link>
      </p>

      <section className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile
          label="Plan"
          value={ws.plan}
          accent={ws.billing_status.replace("_", " ")}
        />
        <Tile
          label="Tasks this period"
          value={ws.total_tasks.toLocaleString()}
        />
        <Tile
          label="Next invoice (est.)"
          value={ws.plan === "free" ? "—" : `$${(ws.estimated_next_invoice_cents / 100).toFixed(2)}`}
        />
        <Tile
          label="Stripe customer"
          value={ws.stripe_customer_id ?? "—"}
          mono
        />
      </section>

      <section className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2">
        <KvCard
          title="Billing period"
          rows={[
            ["Start", ws.billing_period_start ?? "—"],
            ["End", ws.billing_period_end ?? "—"],
            ["Last reported to Stripe", ws.reported_to_stripe_at ?? "—"],
          ]}
        />
        <KvCard
          title="Contact"
          rows={[
            ["Owner email", ws.owner_email ?? "—"],
          ]}
        />
      </section>

      <section className="mb-6 rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold text-foreground">Invoices ({invoices.length})</h2>
        </div>
        {invoices.length === 0 ? (
          <p className="px-5 py-4 text-sm text-muted-foreground">No invoices yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/30 text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2 text-left">Created</th>
                <th className="px-4 py-2 text-left">Period</th>
                <th className="px-4 py-2 text-left">Status</th>
                <th className="px-4 py-2 text-right">Amount</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <tr key={inv.id} className="border-b border-border last:border-b-0">
                  <td className="px-4 py-2.5 text-muted-foreground">{formatDate(inv.created_at)}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">
                    {inv.period_start && inv.period_end
                      ? `${formatDate(inv.period_start)} – ${formatDate(inv.period_end)}`
                      : "—"}
                  </td>
                  <td className="px-4 py-2.5 capitalize">{inv.status}</td>
                  <td className="px-4 py-2.5 text-right font-mono">
                    ${(inv.total_cents / 100).toFixed(2)} {inv.currency.toUpperCase()}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {inv.hosted_url ? (
                      <a
                        className="text-xs text-primary hover:underline"
                        href={inv.hosted_url}
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        Open
                      </a>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold text-foreground">Recent Stripe events</h2>
          <Link href="/admin/billing/webhooks" className="text-xs text-primary hover:underline">
            See all →
          </Link>
        </div>
        {recentEvents.length === 0 ? (
          <p className="px-5 py-4 text-sm text-muted-foreground">No events yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {recentEvents.map((evt) => (
              <li key={evt.id} className="flex items-center justify-between px-5 py-2.5 text-sm">
                <div>
                  <span className="font-mono text-xs text-muted-foreground">{evt.id}</span>
                  <span className="ml-2">{evt.type}</span>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  {evt.error ? <Badge variant="destructive">error</Badge> : null}
                  <span className="text-muted-foreground">{formatDate(evt.received_at)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

async function listRecentBillingEventsForWorkspace(workspaceId: string) {
  const { rows } = await db().query<{
    id: string;
    type: string;
    received_at: string;
    processed_at: string | null;
    error: string | null;
  }>(
    `SELECT id, type, received_at::text, processed_at::text, error
       FROM billing_events
      WHERE workspace_id = $1
      ORDER BY received_at DESC
      LIMIT 10`,
    [workspaceId],
  );
  return rows;
}

function Tile({ label, value, accent, mono }: { label: string; value: string; accent?: string; mono?: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`mt-1 ${mono ? "font-mono text-base" : "text-2xl font-semibold"} text-foreground`}>
        {value}
      </p>
      {accent ? <p className="mt-0.5 text-[11px] capitalize text-muted-foreground">{accent}</p> : null}
    </div>
  );
}

function KvCard({ title, rows }: { title: string; rows: Array<[string, string]> }) {
  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="border-b border-border px-5 py-3">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      </div>
      <dl className="space-y-2 p-5 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="font-mono text-xs text-foreground">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(iso),
  );
}
