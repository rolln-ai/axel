import Link from "next/link";
import { PageHeader } from "../../../_components/PageHeader";
import { requireSuperAdmin } from "../../../../lib/admin-auth";
import { listAdminAudit } from "../../../../lib/admin-queries";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const dynamic = "force-dynamic";

export default async function AdminAuditPage() {
  await requireSuperAdmin();
  const rows = await listAdminAudit(200);

  return (
    <>
      <PageHeader
        eyebrow="Admin"
        title="Audit feed"
        description="Every action taken in the /admin section. action prefix: 'admin.'"
      />
      <section className="rounded-lg border border-border bg-card">
        <div className="border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold text-foreground">{rows.length} entries</h2>
        </div>
        {rows.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>Metadata</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(r.created_at).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-sm">
                    {r.actor_email ? (
                      r.actor_user_id ? (
                        <Link href={`/admin/users/${r.actor_user_id}`} className="hover:underline">
                          {r.actor_email}
                        </Link>
                      ) : (
                        r.actor_email
                      )
                    ) : (
                      <span className="italic text-muted-foreground">deleted user</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary" className="font-mono text-[10px]">
                      {r.action.replace(/^admin\./, "")}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-[11px] text-muted-foreground">
                    {r.target_type === "workspace" && r.target_id ? (
                      <Link href={`/admin/workspaces/${r.target_id}`} className="hover:underline">
                        {r.target_id}
                      </Link>
                    ) : r.target_type === "user" && r.target_id ? (
                      <Link href={`/admin/users/${r.target_id}`} className="hover:underline">
                        {r.target_id}
                      </Link>
                    ) : (
                      r.target_id ?? "—"
                    )}
                  </TableCell>
                  <TableCell className="max-w-md">
                    <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[10px] text-muted-foreground">
                      {JSON.stringify(r.metadata, null, 0)}
                    </pre>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="px-5 py-6 text-sm text-muted-foreground">
            No admin actions logged yet.
          </p>
        )}
      </section>
    </>
  );
}
