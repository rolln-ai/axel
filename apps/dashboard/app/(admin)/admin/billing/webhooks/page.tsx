import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "../../../../_components/PageHeader";
import { requireSuperAdmin } from "../../../../../lib/admin-auth";
import { listRecentBillingEvents } from "../../../../../lib/admin-billing";

export const dynamic = "force-dynamic";

export default async function AdminBillingWebhooksPage() {
  await requireSuperAdmin();
  const events = await listRecentBillingEvents(100);

  return (
    <>
      <PageHeader
        eyebrow="Admin / Billing"
        title="Stripe webhook journal"
        description="Most recent 100 events received at /api/stripe/webhook."
      />
      <p className="mb-4 text-xs">
        <Link href="/admin/billing" className="text-primary hover:underline">
          ← Back to billing list
        </Link>
      </p>

      <section className="rounded-lg border border-border bg-card">
        {events.length === 0 ? (
          <p className="px-5 py-4 text-sm text-muted-foreground">
            No Stripe events received yet.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/30 text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2 text-left">Received</th>
                <th className="px-4 py-2 text-left">Type</th>
                <th className="px-4 py-2 text-left">Workspace</th>
                <th className="px-4 py-2 text-left">Status</th>
                <th className="px-4 py-2 text-left">Event ID</th>
              </tr>
            </thead>
            <tbody>
              {events.map((evt) => (
                <tr key={evt.id} className="border-b border-border last:border-b-0">
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">
                    {new Intl.DateTimeFormat(undefined, {
                      dateStyle: "short",
                      timeStyle: "short",
                    }).format(new Date(evt.received_at))}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs">{evt.type}</td>
                  <td className="px-4 py-2.5 text-xs">
                    {evt.workspace_id ? (
                      <Link
                        href={`/admin/billing/${evt.workspace_id}`}
                        className="text-foreground hover:underline"
                      >
                        {evt.workspace_name ?? evt.workspace_id}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-xs">
                    {evt.error ? (
                      <Badge variant="destructive" className="text-[10px]">
                        {evt.error.slice(0, 40)}
                      </Badge>
                    ) : evt.processed_at ? (
                      <Badge variant="secondary" className="text-[10px]">processed</Badge>
                    ) : (
                      <Badge variant="outline" className="text-[10px]">pending</Badge>
                    )}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-[11px] text-muted-foreground">
                    {evt.id}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
