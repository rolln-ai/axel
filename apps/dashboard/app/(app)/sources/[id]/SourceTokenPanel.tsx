"use client";

import { useActionState } from "react";
import type { SourceProvider } from "@axel/shared";
import { rotateSourceToken } from "../../../../lib/source-actions";
import type { ActionState } from "../../../../lib/action-data";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { CopyButton } from "../../_components/CopyButton";
import { ConfirmAction } from "../../../_components/ConfirmAction";
import { useToast } from "../../../_components/Toast";
import {
  sourceAuthenticationCopy,
  sourceAuthHeaderExample,
  sourceProviderLabel,
  sourceUsesAxelToken,
} from "../../../../lib/source-ingest-auth";

interface Props {
  sourceId: string;
  ingestUrl: string;
  canRotate: boolean;
  /** AXE-23 — provider preset configured on the source. */
  provider?: SourceProvider;
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
  const usesAxelToken = sourceUsesAxelToken(provider);

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
            {`POST ${ingestUrl}\n${sourceAuthHeaderExample(provider)}`}
          </pre>
          <p className="text-xs text-muted-foreground">
            {sourceAuthenticationCopy(provider)}
            {usesAxelToken
              ? " The plaintext token is shown once on creation. Rotate below to issue a new one."
              : " Axel verifies that authentication before storing or queueing the payload."}
          </p>
        </div>
      </div>

      <div className="grid gap-2 md:grid-cols-[200px_1fr] md:items-start md:gap-6">
        <Label className="pt-2 text-sm font-medium">Inbound authentication</Label>
        <div className="space-y-2">
          {signingSecretFingerprint ? (
            <p className="text-xs text-foreground">
              <strong className="font-semibold capitalize">{sourceProviderLabel(provider)}</strong>{" "}
              provider authentication active.
              <span className="ml-1 font-mono text-muted-foreground">
                (fingerprint {signingSecretFingerprint})
              </span>
            </p>
          ) : provider === "custom" ? (
            <p className="text-xs text-muted-foreground">
              No provider signing secret configured — the ingest worker accepts any payload that
              presents the source token. Configure a custom HMAC secret to verify signatures before
              R2 / queue writes.
            </p>
          ) : (
            <p className="text-xs text-destructive">
              {sourceProviderLabel(provider)} authentication is misconfigured. The ingest worker
              rejects requests before R2 / queue writes until an owner or admin repairs the signing
              secret.
            </p>
          )}
        </div>
      </div>

      {usesAxelToken ? (
        <div className="grid gap-2 md:grid-cols-[200px_1fr] md:items-start md:gap-6">
          <Label className="pt-2 text-sm font-medium">Source token</Label>
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Tokens are stored hashed and can&apos;t be recovered. Rotate to issue a new token; the
              edge blocks this source before the database change and resumes only after it receives
              the committed new token hash.
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
                body="Rotate this source token? The edge will block this source before the token changes and resume with the committed new hash."
                confirmLabel="Rotate"
                destructive
              >
                <Button type="button" variant="secondary" disabled={!canRotate || pending}>
                  {pending ? "Rotating…" : "Rotate token"}
                </Button>
              </ConfirmAction>
            </form>
            {!canRotate ? (
              <p className="text-xs text-muted-foreground">
                Only owners and admins can rotate source tokens.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
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
