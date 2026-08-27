import Link from "next/link";
import { redirect } from "next/navigation";
import {
  ADMIN_MFA_ENROLLMENT_MINUTES,
  ADMIN_MFA_FRESH_MINUTES,
  buildTotpUri,
  decryptAdminMfaSecret,
  getAdminMfaMethod,
  isPendingAdminMfaEnrollmentOwned,
} from "../../lib/admin-mfa";
import { safeReturnTo } from "../../lib/return-to";
import { getAuthenticatedUser } from "../../lib/session";
import { currentSessionTokenHash } from "../../lib/impersonation";
import { Logo } from "../_brand/Logo";
import { AdminMfaCodeForm, AdminMfaEnrollmentForm } from "./AdminMfaForm";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function AdminMfaPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const returnTo = safeReturnTo((await searchParams).returnTo) ?? undefined;
  const auth = await getAuthenticatedUser();
  if (!auth) redirect(`/login?returnTo=${encodeURIComponent(returnTo ?? "/admin")}`);
  if (!auth.user.isSuperAdmin || auth.impersonator) redirect("/dashboard");

  const method = await getAdminMfaMethod(auth.user.id);
  const sessionTokenHash = await currentSessionTokenHash();
  const verifiedAt = auth.adminMfaVerifiedAt ? Date.parse(auth.adminMfaVerifiedAt) : 0;
  const fresh =
    method?.enabledAt
    && Number.isFinite(verifiedAt)
    && Date.now() - verifiedAt < ADMIN_MFA_FRESH_MINUTES * 60_000;
  if (fresh) redirect(returnTo ?? "/admin");

  let pendingSecret: string | null = null;
  let setupError: string | null = null;
  const pendingOwnedBySession = isPendingAdminMfaEnrollmentOwned(method, sessionTokenHash);
  if (method && pendingOwnedBySession) {
    try {
      pendingSecret = await decryptAdminMfaSecret(method.secretCiphertext, auth.user.id);
    } catch {
      setupError = "The pending authenticator setup cannot be decrypted. Verify the server encryption key, then restart setup.";
    }
  }

  return (
    <main className="grid min-h-svh place-items-center bg-muted/30 px-4 py-10">
      <div className="w-full max-w-md space-y-6">
        <Link href="/" className="flex items-center justify-center gap-2" aria-label="Axel home">
          <Logo size={26} />
          <span className="text-lg font-semibold tracking-tight">Axel</span>
        </Link>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {method?.enabledAt ? "Verify administrator access" : "Protect administrator access"}
            </CardTitle>
            <CardDescription>
              Administrator access requires a fresh authenticator code every {ADMIN_MFA_FRESH_MINUTES} minutes.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {!method?.enabledAt && !pendingOwnedBySession ? (
              <>
                {method ? (
                  <Alert>
                    <AlertDescription>
                      Authenticator setup is valid for {ADMIN_MFA_ENROLLMENT_MINUTES} minutes and only in the password-confirmed session that started it. Confirm your password to restart setup here.
                    </AlertDescription>
                  </Alert>
                ) : null}
                <AdminMfaEnrollmentForm returnTo={returnTo} />
              </>
            ) : null}
            {setupError ? (
              <Alert variant="destructive">
                <AlertDescription>{setupError}</AlertDescription>
              </Alert>
            ) : null}
            {pendingSecret ? (
              <>
                <div className="space-y-3 text-sm text-muted-foreground">
                  <p>Add an account in your authenticator app with this key, then enter the current code.</p>
                  <div className="rounded-md border border-border bg-muted p-3">
                    <p className="mb-1 text-xs font-medium text-foreground">Setup key</p>
                    <code className="break-all font-mono text-xs text-foreground">{pendingSecret}</code>
                  </div>
                  <details>
                    <summary className="cursor-pointer text-xs text-foreground">Show authenticator URI</summary>
                    <code className="mt-2 block break-all rounded-md border border-border bg-muted p-3 text-[11px] text-foreground">
                      {buildTotpUri(pendingSecret, auth.user.email)}
                    </code>
                  </details>
                </div>
                <AdminMfaCodeForm returnTo={returnTo} />
              </>
            ) : null}
            {method?.enabledAt ? <AdminMfaCodeForm returnTo={returnTo} /> : null}
          </CardContent>
        </Card>
        <p className="text-center text-xs text-muted-foreground">
          Signed in as {auth.user.email}. <Link href="/dashboard" className="underline">Return to dashboard</Link>
        </p>
      </div>
    </main>
  );
}
