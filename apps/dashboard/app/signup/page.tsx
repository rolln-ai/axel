import Link from "next/link";
import { getSetupProblem } from "../../lib/config";
import { SignupForm } from "./SignupForm";
import { signupSource } from "../../lib/signup-source";
import { Logo } from "../_brand/Logo";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ invite?: string; ref?: string }>;
}) {
  const setupProblem = getSetupProblem();
  const params = await searchParams;
  const inviteToken = params.invite;
  return (
    <main className="grid min-h-svh place-items-center bg-muted/30 px-4 py-10">
      <div className="w-full max-w-sm space-y-6">
        <Link href="/" className="flex items-center justify-center gap-2" aria-label="Axel home">
          <Logo size={26} />
          <span className="text-lg font-semibold tracking-tight">Axel</span>
        </Link>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {inviteToken ? "Join the workspace" : "Set up your workspace"}
            </CardTitle>
            <CardDescription>
              {inviteToken
                ? "Create an account to join this workspace."
                : "Create an account, then connect your first webhook source."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {setupProblem ? (
              <Alert variant="destructive">
                <AlertDescription>{setupProblem}</AlertDescription>
              </Alert>
            ) : (
              <SignupForm inviteToken={inviteToken} source={signupSource(params.ref)} />
            )}
          </CardContent>
        </Card>
        <p className="text-center text-sm text-muted-foreground">
          Already have an account?{" "}
          <Link href="/login" className="text-foreground underline-offset-4 hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
