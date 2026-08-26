import Link from "next/link";
import { PageHeader } from "../../../_components/PageHeader";
import { requireSuperAdmin } from "../../../../lib/admin-auth";
import { listAllWorkspaces } from "../../../../lib/admin-queries";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { WorkspaceListRowActions } from "./WorkspaceListRowActions";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 100;

export default async function AdminWorkspacesPage(
  props: { searchParams: Promise<{ page?: string }> },
) {
  await requireSuperAdmin();
  const sp = await props.searchParams;
  const page = parsePage(sp.page);
  // Fetch one extra row so we know whether an older page exists without a
  // second COUNT query over the multi-join.
  const rows = await listAllWorkspaces(PAGE_SIZE + 1, (page - 1) * PAGE_SIZE);
  const hasOlder = rows.length > PAGE_SIZE;
  const workspaces = rows.slice(0, PAGE_SIZE);
  const paginated = page > 1 || hasOlder;

  return (
    <>
      <PageHeader
        eyebrow="Admin"
        title="Workspaces"
        description="Every workspace on the platform. Click into a row to suspend, restore, or delete."
      />
      <section className="rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold text-foreground">
            {paginated ? `${workspaces.length} on page ${page}` : `${workspaces.length} total`}
          </h2>
        </div>
        {workspaces.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead className="text-right">Members</TableHead>
                <TableHead className="text-right">Sources</TableHead>
                <TableHead className="text-right">Destinations</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {workspaces.map((ws) => (
                <TableRow key={ws.id}>
                  <TableCell>
                    <Link href={`/admin/workspaces/${ws.id}`} prefetch={false} className="block">
                      <strong className="text-sm font-medium text-foreground">{ws.name}</strong>
                      <small className="block font-mono text-[11px] text-muted-foreground">{ws.id}</small>
                    </Link>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {ws.owner_email ?? <span className="italic">—</span>}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">{ws.member_count}</TableCell>
                  <TableCell className="text-right font-mono text-sm">{ws.source_count}</TableCell>
                  <TableCell className="text-right font-mono text-sm">{ws.destination_count}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant={ws.status === "active" ? "secondary" : "destructive"}>
                        {ws.status}
                      </Badge>
                      {ws.billing_exempt ? (
                        <Badge variant="outline" className="text-[10px]">exempt</Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(ws.created_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-right">
                    <WorkspaceListRowActions
                      workspaceId={ws.id}
                      workspaceName={ws.name}
                      status={ws.status}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="px-5 py-6 text-sm text-muted-foreground">
            {page > 1 ? "No workspaces on this page." : "No workspaces yet."}
          </p>
        )}
        {paginated ? (
          <div className="flex items-center justify-between border-t border-border px-5 py-3 text-sm">
            {page > 1 ? (
              <Link
                href={page === 2 ? "/admin/workspaces" : `/admin/workspaces?page=${page - 1}`}
                prefetch={false}
                className="text-primary underline-offset-2 hover:underline"
              >
                ← Newer
              </Link>
            ) : (
              <span />
            )}
            {hasOlder ? (
              <Link
                href={`/admin/workspaces?page=${page + 1}`}
                prefetch={false}
                className="text-primary underline-offset-2 hover:underline"
              >
                Older →
              </Link>
            ) : (
              <span />
            )}
          </div>
        ) : null}
      </section>
    </>
  );
}

function parsePage(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}
