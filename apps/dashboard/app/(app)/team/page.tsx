import { InviteForm } from "./InviteForm";
import { TeamMemberActions } from "./TeamMemberActions";
import { CancelInviteButton } from "./CancelInviteButton";
import { EmptyState } from "../../EmptyState";
import { LocalTime } from "../../_components/LocalTime";
import { PageHeader } from "../../_components/PageHeader";
import { listInvites, listTeamMembers } from "../../../lib/repositories";
import { requireSession } from "../../../lib/session";
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

export default async function TeamPage() {
  const session = await requireSession();
  const workspaceId = session.activeWorkspace.workspace_id;
  const [members, invites] = await Promise.all([listTeamMembers(workspaceId), listInvites(workspaceId)]);
  const role = session.activeWorkspace.role;
  const canInvite = role === "owner" || role === "admin";
  const canManageMembers = canInvite;
  const isOwner = role === "owner";

  return (
    <>
      <PageHeader
        eyebrow="Workspace"
        title="Team"
        description="Manage workspace members and outstanding invitations."
      />

      <section className="rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold text-foreground">Team members</h2>
          <Badge variant="outline" className="capitalize">
            {session.activeWorkspace.role}
          </Badge>
        </div>
        {members.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Joined</TableHead>
                {canManageMembers ? <TableHead className="text-right">Manage</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((member) => {
                // Admins can manage members/admins but not owners; only owners
                // manage owners. The server re-enforces every guard regardless.
                const canManageThis = canManageMembers && (isOwner || member.role !== "owner");
                const isSelf = member.user_id === session.user.id;
                return (
                <TableRow key={member.user_id}>
                  <TableCell className="text-sm font-medium text-foreground">
                    {member.name}
                    {isSelf ? (
                      <Badge variant="secondary" className="ml-2 align-middle">
                        you
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{member.email}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="capitalize">{member.role}</Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    <LocalTime value={member.created_at} mode="date" />
                  </TableCell>
                  {canManageMembers ? (
                    <TableCell className="text-right">
                      {canManageThis ? (
                        <TeamMemberActions
                          userId={member.user_id}
                          currentRole={member.role as "owner" | "admin" | "member"}
                          canManageOwners={isOwner}
                          isSelf={isSelf}
                        />
                      ) : (
                        <span className="text-[11px] text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  ) : null}
                </TableRow>
                );
              })}
            </TableBody>
          </Table>
        ) : (
          <div className="p-5">
            <EmptyState title="No members yet" body="Invite teammates below to start collaborating." />
          </div>
        )}
      </section>

      <section className="mt-6 rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold text-foreground">Invites</h2>
          {canInvite ? null : <Badge variant="outline">read-only</Badge>}
        </div>
        <div className="space-y-5 p-5">
          {canInvite ? (
            <InviteForm />
          ) : (
            <p className="text-sm text-muted-foreground">
              Only owners and admins can invite teammates.
            </p>
          )}
          {invites.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Expires</TableHead>
                  {canInvite ? <TableHead className="text-right">Manage</TableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {invites.map((invite) => (
                  <TableRow key={invite.id}>
                    <TableCell className="text-sm text-foreground">{invite.email}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="capitalize">{invite.role}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={invite.accepted_at ? "default" : "secondary"}
                        className="capitalize"
                      >
                        {invite.accepted_at ? "accepted" : "pending"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      <LocalTime value={invite.expires_at} mode="date" />
                    </TableCell>
                    {canInvite ? (
                      <TableCell className="text-right">
                        {invite.accepted_at ? (
                          <span className="text-[11px] text-muted-foreground">—</span>
                        ) : (
                          <CancelInviteButton inviteId={invite.id} />
                        )}
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}
        </div>
      </section>
    </>
  );
}
