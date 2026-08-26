import Link from "next/link";
import { redirect } from "next/navigation";
import { getSetupProblem } from "../../lib/config";
import { safeReturnTo } from "../../lib/return-to";
import { getAuthenticatedUser, getCurrentSession } from "../../lib/session";
import { LoginForm } from "./LoginForm";
import { Logo } from "../_brand/Logo";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const setupProblem = getSetupProblem();
  // Validated origin path from the auth-gate redirect (see lib/return-to.ts);
  // an invalid or absent value degrades to the plain /dashboard flow.
  const returnTo = safeReturnTo((await searchParams).returnTo);
  // Already signed in? Don't show a login form. Send them to the app, or to
  // onboarding if they have no workspace (e.g. just deleted their last one).
  if (!setupProblem) {
    const auth = await getAuthenticatedUser();
    if (auth) {
      const session = await getCurrentSession();
      redirect(session ? returnTo ?? "/dashboard" : "/welcome");
    }
  }
  return (
    <main className="grid min-h-svh place-items-center bg-muted/30 px-4 py-10">
      <div className="w-full max-w-sm space-y-6">
        <Link href="/" className="flex items-center justify-center gap-2" aria-label="Axel home">
          <Logo size={26} />
          <span className="text-lg font-semibold tracking-tight">Axel</span>
        </Link>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Welcome back</CardTitle>
            <CardDescription>
              Operate webhook sources, routes, deliveries, and team access.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {setupProblem ? (
              <Alert variant="destructive">
                <AlertDescription>{setupProblem}</AlertDescription>
              </Alert>
            ) : (
              <LoginForm returnTo={returnTo ?? undefined} />
            )}
          </CardContent>
        </Card>
        <p className="text-center text-sm text-muted-foreground">
          New workspace?{" "}
          <Link href="/signup" className="text-foreground underline-offset-4 hover:underline">
            Create one
          </Link>
        </p>
      </div>
    </main>
  );
}
