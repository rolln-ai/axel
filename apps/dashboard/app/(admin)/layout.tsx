import { Suspense } from "react";
import { redirect } from "next/navigation";
import { adminMfaChallengePath, hasFreshAdminMfa } from "../../lib/admin-auth";
import { getAuthenticatedUser, type AuthenticatedUser } from "../../lib/session";
import { ToastProvider } from "../_components/Toast";
import { AdminShell } from "./AdminShell";
import { AdminShellChromeSkeleton } from "./AdminShellChromeSkeleton";

/**
 * Layout for the super-admin route group. Calls `requireSuperAdmin()` which
 * uses `requireAuthenticatedUser` (NOT `requireSession`), so a super-admin
 * with no workspace memberships can still land here without being redirected
 * into a workspace-less crash.
 *
 * As with (app)/layout.tsx, the auth lookup is handed down as a Promise so
 * the AdminShell chrome can stream in via a Suspense skeleton on cold pools
 * instead of leaving the user on the bare root loading.tsx for 10-30s.
 */
export default function AdminGroupLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const authPromise = getAuthenticatedUser();
  return (
    <ToastProvider>
      <Suspense fallback={<AdminShellChromeSkeleton />}>
        <AuthenticatedAdminShell authPromise={authPromise}>
          {children}
        </AuthenticatedAdminShell>
      </Suspense>
    </ToastProvider>
  );
}

async function AuthenticatedAdminShell({
  authPromise,
  children,
}: {
  authPromise: Promise<AuthenticatedUser | null>;
  children: React.ReactNode;
}) {
  const auth = await authPromise;
  if (!auth) redirect("/login");
  // Mirror the requireSuperAdmin() gate: non-admins land back on /dashboard
  // so /admin URLs aren't enumerable as "you exist but you're not admin."
  if (!auth.user.isSuperAdmin) redirect("/dashboard");
  if (auth.impersonator) redirect("/dashboard");
  if (!hasFreshAdminMfa(auth)) {
    redirect(adminMfaChallengePath());
  }
  return <AdminShell auth={auth}>{children}</AdminShell>;
}
