import "server-only";
import { redirect } from "next/navigation";
import { getAuthenticatedUser, requireAuthenticatedUser, type AuthenticatedUser } from "./session";

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
  return auth;
}

/** Non-throwing variant — returns null if caller is not a super-admin. */
export async function getSuperAdmin(): Promise<AuthenticatedUser | null> {
  const auth = await getAuthenticatedUser();
  if (!auth || !auth.user.isSuperAdmin) return null;
  return auth;
}
