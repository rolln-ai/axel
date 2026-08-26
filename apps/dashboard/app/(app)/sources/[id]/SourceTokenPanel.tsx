"use client";

import { useActionState } from "react";
import { rotateSourceToken } from "../../../../lib/source-actions";
import type { ActionState } from "../../../../lib/action-data";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { CopyButton } from "../../_components/CopyButton";
import { ConfirmAction } from "../../../_components/ConfirmAction";
import { useToast } from "../../../_components/Toast";

interface Props {
  sourceId: string;
  ingestUrl: string;
  canRotate: boolean;
  /** AXE-23 — provider preset configured on the source. */
  provider?: "custom" | "stripe" | "github" | "shopify" | "chargebee";
  /** Short hex digest of the provider signing secret, if configured. */
  signingSecretFingerprint?: string | null;
}

export function SourceTokenPanel({
  sourceId,
  ingestUrl,
  canRotate,
  provider = "custom",
  signingSecretFingerprint = null,
}: Props) {
  const [state, action, pending] = useActionState<ActionState, FormData>(rotateSourceToken, {});

  return (
    <div className="space-y-4">
      <div className="grid gap-2 md:grid-cols-[200px_1fr] md:items-start md:gap-6">
        <Label className="pt-2 text-sm font-medium">Ingest URL</Label>
        <CopyableValue value={ingestUrl} />
      </div>

      <div className="grid gap-2 md:grid-cols-[200px_1fr] md:items-start md:gap-6">
        <Label className="pt-2 text-sm font-medium">Webhook request</Label>
        <div className="space-y-2">
          <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-xs leading-relaxed select-all">
            {`POST ${ingestUrl}?token=YOUR_SOURCE_TOKEN`}
          </pre>
          <p className="text-xs text-muted-foreground">
            Point your provider at this URL. The source token can be sent as the{" "}
            <code className="font-mono">?token=</code> query parameter (shown above) or as an{" "}
            <code className="font-mono">x-axel-token</code> request header — use whichever your
            provider supports. The plaintext token is shown once on creation; rotate below to issue a
            new one.
          </p>
        </div>
      </div>

      <div className="grid gap-2 md:grid-cols-[200px_1fr] md:items-start md:gap-6">
        <Label className="pt-2 text-sm font-medium">Signature verification</Label>
        <div className="space-y-2">
          {signingSecretFingerprint ? (
            <p className="text-xs text-foreground">
              <strong className="font-semibold capitalize">{providerLabel(provider)}</strong>{" "}
              HMAC verification active.
              <span className="ml-1 font-mono text-muted-foreground">
                (fingerprint {signingSecretFingerprint})
              </span>
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              No provider signing secret configured — the ingest worker accepts any payload that
              presents the source token. Configure a provider on source create to verify
              signatures before R2 / queue writes.
            </p>
          )}
        </div>
      </div>

      <div className="grid gap-2 md:grid-cols-[200px_1fr] md:items-start md:gap-6">
        <Label className="pt-2 text-sm font-medium">Source token</Label>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Tokens are stored hashed and can&apos;t be recovered. Rotate to issue a new token;
            the old token stops working immediately.
          </p>

          {state.error ? (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          ) : null}
          {state.data?.plaintextToken ? (
            <Alert>
              <AlertDescription className="space-y-2">
                <span className="block">{state.notice ?? "Source token rotated."}</span>
                <CopyableValue value={state.data.plaintextToken} />
              </AlertDescription>
            </Alert>
          ) : null}

          <form action={action}>
            <input type="hidden" name="source_id" value={sourceId} />
            <ConfirmAction
              title="Rotate source token"
              body="Rotate this source token? The old token stops working immediately."
              confirmLabel="Rotate"
              destructive
            >
              <Button type="button" variant="secondary" disabled={!canRotate || pending}>
                {pending ? "Rotating…" : "Rotate token"}
              </Button>
            </ConfirmAction>
          </form>
          {!canRotate ? (
            <p className="text-xs text-muted-foreground">Only owners and admins can rotate source tokens.</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function providerLabel(p: "custom" | "stripe" | "github" | "shopify" | "chargebee"): string {
  switch (p) {
    case "stripe": return "Stripe";
    case "github": return "GitHub";
    case "shopify": return "Shopify";
    case "chargebee": return "Chargebee";
    case "custom": return "Custom";
  }
}

function CopyableValue({ value }: { value: string }) {
  const toast = useToast();

  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
      <code className="min-w-0 flex-1 truncate font-mono text-xs">
        {value}
      </code>
      <CopyButton
        value={value}
        variant="ghost"
        size="icon"
        className="size-7 shrink-0"
        resetAfterMs={1200}
        onCopyError={() =>
          toast.error("Couldn't copy to the clipboard. Select the text and copy it manually.")
        }
      />
    </div>
  );
}
