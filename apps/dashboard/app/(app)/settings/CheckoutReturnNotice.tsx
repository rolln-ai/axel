"use client";

import { useRouter } from "next/navigation";
import { CheckCircle2, Info, X } from "lucide-react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { CheckoutReturnNotice as Notice } from "../../../lib/billing/checkout-return-notice";

/**
 * Dismissible banner shown above the Billing panel when the user returns from
 * Stripe Checkout (`?checkout=success|cancel`). Dismissing replaces the URL
 * without the checkout param so a reload/back-nav doesn't resurrect the
 * notice; the message itself comes from deriveCheckoutReturnNotice (pure,
 * unit-tested).
 */
export function CheckoutReturnNotice({ notice }: { notice: Notice }) {
  const router = useRouter();
  const success = notice.tone === "success";
  return (
    <Alert
      className={
        success
          ? "mb-6 border-green-600/40 bg-green-500/5"
          : "mb-6"
      }
    >
      {success ? (
        <CheckCircle2 className="text-green-700 dark:text-green-400" aria-hidden />
      ) : (
        <Info className="text-muted-foreground" aria-hidden />
      )}
      <AlertTitle>{notice.title}</AlertTitle>
      <AlertDescription>{notice.body}</AlertDescription>
      <AlertAction>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-6"
          aria-label="Dismiss"
          onClick={() => router.replace("/settings?tab=billing", { scroll: false })}
        >
          <X className="size-3.5" />
        </Button>
      </AlertAction>
    </Alert>
  );
}
