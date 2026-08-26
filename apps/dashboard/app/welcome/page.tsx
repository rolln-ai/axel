import { redirect } from "next/navigation";
import Link from "next/link";
import { logOut } from "../../lib/auth-actions";
import { stopImpersonationAction } from "../../lib/admin-actions";
import { getAuthenticatedUser, getCurrentSession } from "../../lib/session";
import { Logo } from "../_brand/Logo";
import { StopImpersonationBar } from "../(admin)/_components/StopImpersonationBar";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CreateFirstWorkspaceForm } from "./CreateFirstWorkspaceForm";

export const dynamic = "force-dynamic";

/**
 * The "no workspaces yet" landing. A user reaches it when they are signed in
 * but belong to no workspace — most commonly right after deleting their last
 * one. It lets them spin up a fresh workspace without being bounced to /login.
 *
 * An impersonating admin can land here too (the target user has no
 * memberships, so (app)/layout bounces them out of /dashboard). In that case
 * we keep the red impersonation bar visible and route "Sign out" through
 * stopImpersonationAction — plain logOut() would destroy the impersonated
 * session AND fully log the admin out instead of restoring their own session.
 */
export default async function WelcomePage() {
  const auth = await getAuthenticatedUser();
  if (!auth) redirect("/login");

  // Already in a workspace? Nothing to onboard — send them to the app.
  const session = await getCurrentSession();
  if (session) redirect("/dashboard");

  const impersonator = auth.impersonator;

  return (
    <>
      {impersonator ? (
        <StopImpersonationBar
          impersonatorEmail={impersonator.email}
          viewingAs={auth.user.email}
        />
      ) : null}
      <main className="grid min-h-svh place-items-center bg-muted/30 px-4 py-10">
        <div className="w-full max-w-sm space-y-6">
          <Link href="/dashboard" className="flex items-center justify-center gap-2" aria-label="Axel home">
            <Logo size={26} />
            <span className="text-lg font-semibold tracking-tight">Axel</span>
          </Link>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">No workspaces yet</CardTitle>
              <CardDescription>
                You&apos;re signed in as {auth.user.email} but aren&apos;t a member of any workspace.
                Create one to start operating webhooks again.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <CreateFirstWorkspaceForm />
            </CardContent>
          </Card>
          <div className="flex items-center justify-center gap-1 text-center text-sm text-muted-foreground">
            <span>{impersonator ? "Done here?" : "Wrong account?"}</span>
            <form action={impersonator ? stopImpersonationAction : logOut}>
              <button type="submit" className="text-foreground underline-offset-4 hover:underline">
                {impersonator ? "Return to your admin account" : "Sign out"}
              </button>
            </form>
          </div>
        </div>
      </main>
    </>
  );
}
