import Link from "next/link";
import { getSetupProblem } from "../../lib/config";
import { VerifyForm } from "./VerifyForm";
import { Logo } from "../_brand/Logo";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Landing page for the emailed verification link. The token is consumed by a
 * button POST (VerifyForm → verifyEmail), never by this GET render, so mail
 * scanners that prefetch links can't burn the single-use token.
 */
export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const setupProblem = getSetupProblem();
  const params = await searchParams;
  const token = params.token ?? "";

  return (
    <main className="grid min-h-svh place-items-center bg-muted/30 px-4 py-10">
      <div className="w-full max-w-sm space-y-6">
        <Link href="/" className="flex items-center justify-center gap-2" aria-label="Axel home">
          <Logo size={26} />
          <span className="text-lg font-semibold tracking-tight">Axel</span>
        </Link>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Confirm your email</CardTitle>
            <CardDescription>
              One click confirms this address and signs you in.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {setupProblem ? (
              <Alert variant="destructive">
                <AlertDescription>{setupProblem}</AlertDescription>
              </Alert>
            ) : !token ? (
              <Alert variant="destructive">
                <AlertDescription>
                  This page needs a verification token. Open the link from your
                  email, or <Link href="/login">sign in</Link> and resend it from
                  the dashboard.
                </AlertDescription>
              </Alert>
            ) : (
              <VerifyForm token={token} />
            )}
          </CardContent>
        </Card>
        <p className="text-center text-sm text-muted-foreground">
          Wrong account?{" "}
          <Link href="/login" className="text-foreground underline-offset-4 hover:underline">
            Back to sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
