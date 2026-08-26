import Link from "next/link";
import { getSetupProblem } from "../../lib/config";
import { ResetForm } from "./ResetForm";
import { Logo } from "../_brand/Logo";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default async function ResetPage({
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
            <CardTitle className="text-base">Choose a new password</CardTitle>
            <CardDescription>
              Pick something at least 12 characters with upper-case, lower-case, and a number.
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
                  This page needs a reset token. Request a new link from the{" "}
                  <Link href="/forgot">forgot-password page</Link>.
                </AlertDescription>
              </Alert>
            ) : (
              <ResetForm token={token} />
            )}
          </CardContent>
        </Card>
        <p className="text-center text-sm text-muted-foreground">
          Remembered it?{" "}
          <Link href="/login" className="text-foreground underline-offset-4 hover:underline">
            Back to sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
