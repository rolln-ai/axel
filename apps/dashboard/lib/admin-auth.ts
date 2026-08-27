import "server-only";
import { redirect } from "next/navigation";
import { ADMIN_MFA_FRESH_MINUTES } from "./admin-mfa";
import { getAuthenticatedUser, requireAuthenticatedUser, type AuthenticatedUser } from "./session";

export function hasFreshAdminMfa(
  auth: AuthenticatedUser,
  nowMs: number = Date.now(),
): boolean {
  if (!auth.adminMfaEnabledAt || !auth.adminMfaVerifiedAt) return false;
  const verifiedAt = Date.parse(auth.adminMfaVerifiedAt);
  return Number.isFinite(verifiedAt)
    && nowMs - verifiedAt >= 0
    && nowMs - verifiedAt < ADMIN_MFA_FRESH_MINUTES * 60_000;
}

export function adminMfaChallengePath(returnTo = "/admin"): string {
  return `/admin-mfa?returnTo=${encodeURIComponent(returnTo)}`;
}

/**
 * Gate for super-admin routes (the `/admin` section). Redirects non-admins
 * to `/dashboard` (not `/login`) so the admin URL surface isn't enumerable.
 *
 * `requireAuthenticatedUser` is used instead of `requireSession` because a
 * super-admin may not belong to any workspace yet still need to manage other
 * accounts.
 */
export async function requireSuperAdmin(): Promise<AuthenticatedUser> {
  const auth = await requireAuthenticatedUser();
  if (!auth.user.isSuperAdmin) {
    redirect("/dashboard");
  }
  if (auth.impersonator || !hasFreshAdminMfa(auth)) {
    redirect(adminMfaChallengePath());
  }
  return auth;
}

/** Non-throwing variant — returns null if caller is not a super-admin. */
export async function getSuperAdmin(): Promise<AuthenticatedUser | null> {
  const auth = await getAuthenticatedUser();
  if (!auth || !auth.user.isSuperAdmin || auth.impersonator || !hasFreshAdminMfa(auth)) return null;
  return auth;
}
