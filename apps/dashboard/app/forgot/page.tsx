import Link from "next/link";
import { getSetupProblem } from "../../lib/config";
import { ForgotForm } from "./ForgotForm";
import { Logo } from "../_brand/Logo";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function ForgotPage() {
  const setupProblem = getSetupProblem();
  return (
    <main className="grid min-h-svh place-items-center bg-muted/30 px-4 py-10">
      <div className="w-full max-w-sm space-y-6">
        <Link href="/" className="flex items-center justify-center gap-2" aria-label="Axel home">
          <Logo size={26} />
          <span className="text-lg font-semibold tracking-tight">Axel</span>
        </Link>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Reset your password</CardTitle>
            <CardDescription>
              Enter your account email and we&rsquo;ll send a one-time link to choose a new password.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {setupProblem ? (
              <Alert variant="destructive">
                <AlertDescription>{setupProblem}</AlertDescription>
              </Alert>
            ) : (
              <ForgotForm />
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
