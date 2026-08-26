import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "../../../../_components/PageHeader";
import { getUserDetail } from "../../../../../lib/admin-queries";
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
import { UserAdminActions } from "./UserAdminActions";

export const dynamic = "force-dynamic";

export default async function AdminUserDetailPage(
  props: { params: Promise<{ id: string }> },
) {
  const { id } = await props.params;
  const auth = await requireSuperAdmin();
  const user = await getUserDetail(id);
  if (!user) notFound();

  const isSelf = user.id === auth.user.id;

  return (
    <>
      <Link
        href="/admin/users"
        className="mb-2 inline-block text-xs text-muted-foreground hover:underline"
      >
        ← All users
      </Link>
      <PageHeader
        eyebrow="User"
        title={user.email}
        description={`${user.name} · ${user.id}`}
        actions={
          user.is_super_admin ? <Badge variant="destructive">super-admin</Badge> : null
        }
      />

      <section className="mb-6 rounded-lg border border-border bg-card p-5">
        <h2 className="mb-3 text-sm font-semibold text-foreground">Account</h2>
        <dl className="grid grid-cols-1 gap-3 text-sm md:grid-cols-3">
          <div>
            <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">Created</dt>
            <dd className="mt-0.5 text-foreground">{new Date(user.created_at).toLocaleString()}</dd>
          </div>
          <div>
            <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">Email verified</dt>
            <dd className="mt-0.5 text-foreground">
              {user.email_verified_at ? new Date(user.email_verified_at).toLocaleString() : "—"}
            </dd>
          </div>
          <div>
            <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">Active sessions</dt>
            <dd className="mt-0.5 font-mono text-foreground">{user.active_session_count}</dd>
          </div>
        </dl>
      </section>

      <section className="mb-6 rounded-lg border border-border bg-card">
        <div className="border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold text-foreground">
            Workspaces ({user.workspaces.length})
          </h2>
        </div>
        {user.workspaces.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Workspace</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {user.workspaces.map((ws) => (
                <TableRow key={ws.workspace_id}>
                  <TableCell>
                    <Link
                      href={`/admin/workspaces/${ws.workspace_id}`}
                      className="text-sm hover:underline"
                    >
                      {ws.workspace_name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant={ws.role === "owner" ? "default" : "secondary"}>{ws.role}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={ws.status === "active" ? "secondary" : "destructive"}>
                      {ws.status}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="px-5 py-4 text-sm text-muted-foreground">No workspace memberships.</p>
        )}
      </section>

      <UserAdminActions
        userId={user.id}
        email={user.email}
        isSuperAdmin={user.is_super_admin}
        isSelf={isSelf}
      />
    </>
  );
}
