import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "../../../../_components/PageHeader";
import { getWorkspaceDetail } from "../../../../../lib/admin-queries";
import { requireSuperAdmin } from "../../../../../lib/admin-auth";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { WorkspaceAdminActions } from "./WorkspaceAdminActions";
import { WorkspacePlanControls } from "./WorkspacePlanControls";

export const dynamic = "force-dynamic";

export default async function AdminWorkspaceDetailPage(
  props: { params: Promise<{ id: string }> },
) {
  const { id } = await props.params;
  const auth = await requireSuperAdmin();
  const detail = await getWorkspaceDetail(id);
  if (!detail) notFound();

  const adminBelongsToWorkspace = detail.members.some((m) => m.user_id === auth.user.id);

  return (
    <>
      <Link
        href="/admin/workspaces"
        className="mb-2 inline-block text-xs text-muted-foreground hover:underline"
      >
        ← All workspaces
      </Link>
      <PageHeader
        eyebrow="Workspace"
        title={detail.name}
        description={`${detail.id}${detail.slug ? ` (${detail.slug})` : ""}`}
        actions={
          <Badge variant={detail.status === "active" ? "secondary" : "destructive"}>
            {detail.status}
          </Badge>
        }
      />

      <section className="mb-6 rounded-lg border border-border bg-card p-5">
        <h2 className="mb-3 text-sm font-semibold text-foreground">Lifecycle</h2>
        <dl className="grid grid-cols-1 gap-3 text-sm md:grid-cols-3">
          <div>
            <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">Created</dt>
            <dd className="mt-0.5 text-foreground">{new Date(detail.created_at).toLocaleString()}</dd>
          </div>
          {detail.suspended_at ? (
            <>
              <div>
                <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">Suspended at</dt>
                <dd className="mt-0.5 text-foreground">
                  {new Date(detail.suspended_at).toLocaleString()}
                </dd>
              </div>
              <div>
                <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">Reason</dt>
                <dd className="mt-0.5 text-foreground">
                  {detail.suspension_reason || <span className="italic text-muted-foreground">none</span>}
                </dd>
              </div>
            </>
          ) : null}
        </dl>
      </section>

      <section className="mb-6 rounded-lg border border-border bg-card">
        <div className="border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold text-foreground">Members ({detail.members.length})</h2>
        </div>
        {detail.members.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Joined</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.members.map((m) => (
                <TableRow key={m.user_id}>
                  <TableCell>
                    <Link href={`/admin/users/${m.user_id}`} className="text-sm hover:underline">
                      {m.email}
                    </Link>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{m.name}</TableCell>
                  <TableCell>
                    <Badge variant={m.role === "owner" ? "default" : "secondary"}>{m.role}</Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(m.created_at).toLocaleDateString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="px-5 py-4 text-sm text-muted-foreground">No members.</p>
        )}
      </section>

      <div className="mb-6">
        <WorkspacePlanControls
          workspaceId={detail.id}
          currentPlan={detail.plan}
          billingStatus={detail.billing_status}
          billingExempt={detail.billing_exempt}
        />
      </div>

      <WorkspaceAdminActions
        workspaceId={detail.id}
        workspaceName={detail.name}
        status={detail.status}
        adminBelongsToWorkspace={adminBelongsToWorkspace}
      />
    </>
  );
}
