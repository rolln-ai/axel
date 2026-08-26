import Link from "next/link";
import { PageHeader } from "../../../_components/PageHeader";
import { requireSuperAdmin } from "../../../../lib/admin-auth";
import { listAllUsers } from "../../../../lib/admin-queries";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const dynamic = "force-dynamic";

export default async function AdminUsersPage(
  props: { searchParams: Promise<{ q?: string }> },
) {
  await requireSuperAdmin();
  const sp = await props.searchParams;
  const q = sp.q?.trim() ?? "";
  const users = await listAllUsers(q || null);

  return (
    <>
      <PageHeader
        eyebrow="Admin"
        title="Users"
        description="All registered users across every workspace."
      />

      <form className="mb-4" action="/admin/users">
        <Input
          type="search"
          name="q"
          aria-label="Search users by email"
          placeholder="Search by email…"
          defaultValue={q}
          className="max-w-sm"
        />
      </form>

      <section className="rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold text-foreground">
            {users.length} {q ? "matching" : "total"}
          </h2>
        </div>
        {users.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Name</TableHead>
                <TableHead className="text-right">Workspaces</TableHead>
                <TableHead>Last seen</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((u) => (
                <TableRow key={u.id}>
                  <TableCell>
                    <Link href={`/admin/users/${u.id}`} prefetch={false} className="block">
                      <strong className="text-sm font-medium text-foreground">{u.email}</strong>
                      <small className="block font-mono text-[11px] text-muted-foreground">{u.id}</small>
                    </Link>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{u.name}</TableCell>
                  <TableCell className="text-right font-mono text-sm">{u.workspace_count}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {u.last_seen_at ? new Date(u.last_seen_at).toLocaleString() : "—"}
                  </TableCell>
                  <TableCell>
                    {u.is_super_admin ? (
                      <Badge variant="destructive">super-admin</Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">user</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(u.created_at).toLocaleDateString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="px-5 py-6 text-sm text-muted-foreground">No users found.</p>
        )}
      </section>
    </>
  );
}
