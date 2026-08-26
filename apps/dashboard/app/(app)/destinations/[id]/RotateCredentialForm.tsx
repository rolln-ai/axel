"use client";

/**
 * Detail-page credential rotation form.
 *
 * Why this lives separately from `EditDestinationForm`:
 *   - That form deliberately ignores `kind: "secret"` fields. Editing a
 *     table name shouldn't make an operator re-paste an AWS access key.
 *   - This form does the inverse — only secrets, no config, dedicated
 *     audit-log entry (`destination.credential_rotated`) on submit.
 *
 * The shape mirrors the row-level rotate form in
 * `app/(app)/destinations/DestinationActions.tsx` so behaviour is
 * consistent whether an operator rotates from the list or from the
 * detail page. The detail-page version stays expanded (no toggle) and
 * shows the current fingerprint at the top so the user can verify what
 * they're about to overwrite — this matters when the rotation is
 * triggered by an "auth failed" message in the data viewer above.
 */
import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { rotateDestinationCredentials } from "../../../../lib/destination-actions";
import type { ActionState } from "../../../../lib/action-data";
import {
  schemaFor,
  type DestinationType,
} from "../../../../lib/destination-defaults";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

interface Props {
  destinationId: string;
  type: DestinationType;
  fingerprintLast4: string | null;
  fingerprintSha256Prefix: string | null;
}

export function RotateCredentialForm({
  destinationId,
  type,
  fingerprintLast4,
  fingerprintSha256Prefix,
}: Props) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    rotateDestinationCredentials,
    {},
  );
  const schema = schemaFor(type);
  const secretFields = schema.fields.filter((f) => f.kind === "secret");
  // "Connect without certificate verification" — postgres/mongodb only; appends
  // the no-verify TLS option to the rotated connection string server-side.
  const [sslNoVerify, setSslNoVerify] = useState(false);
  const noVerifyConfig =
    type === "postgres"
      ? { field: "pg_ssl_no_verify", examples: "Railway, Heroku Postgres", appended: "sslmode=no-verify" }
      : type === "mongodb"
        ? { field: "mongo_tls_no_verify", examples: "a self-hosted replica set", appended: "tlsAllowInvalidCertificates=true" }
        : null;

  // After a successful rotation the fingerprint changes — refresh the
  // server component so the metrics card and data viewer re-render with
  // the new credential in effect.
  useEffect(() => {
    if (state.notice && !state.error) router.refresh();
  }, [state.notice, state.error, router]);

  if (secretFields.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        This destination type doesn&apos;t have any rotatable credentials.
      </p>
    );
  }

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="destination_id" value={destinationId} />
      <input type="hidden" name="type" value={type} />

      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {state.notice ? (
        <Alert>
          <AlertDescription>{state.notice}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-2 md:grid-cols-[200px_1fr] md:gap-6 md:items-start">
        <span className="pt-2 text-sm font-medium">Current credential fingerprint</span>
        <p className="text-xs text-muted-foreground">
          {fingerprintLast4 ? (
            <>
              Ending in{" "}
              <code className="rounded-sm bg-muted px-1 font-mono">•••{fingerprintLast4}</code>
              {fingerprintSha256Prefix ? (
                <>
                  {" "}·{" "}
                  <code className="rounded-sm bg-muted px-1 font-mono">
                    sha256: {fingerprintSha256Prefix}
                  </code>
                </>
              ) : null}
              . Saving below replaces it; the old value is unrecoverable.
            </>
          ) : (
            <>No credential is currently attached. Saving below adds one.</>
          )}
        </p>
      </div>

      {secretFields.map((field) => (
        <div
          key={field.key}
          className="grid gap-2 md:grid-cols-[200px_1fr] md:gap-6 md:items-start"
        >
          <Label htmlFor={`rotate-${field.key}`} className="pt-2 text-sm font-medium">
            {field.label}
          </Label>
          <div className="space-y-1.5">
            {field.inputType === "textarea" ? (
              <Textarea
                id={`rotate-${field.key}`}
                name={field.key}
                rows={5}
                placeholder={field.placeholder ?? ""}
                required={field.required !== false}
                autoComplete="off"
                spellCheck={false}
                className="h-44 resize-y font-mono text-xs field-sizing-fixed"
                disabled={pending}
              />
            ) : (
              <Input
                id={`rotate-${field.key}`}
                name={field.key}
                type={field.inputType ?? "password"}
                placeholder={field.placeholder ?? ""}
                required={field.required !== false}
                autoComplete="new-password"
                disabled={pending}
              />
            )}
            {field.hint ? (
              <p className="text-xs text-muted-foreground">{field.hint}</p>
            ) : null}
          </div>
        </div>
      ))}

      {noVerifyConfig ? (
        <div className="grid gap-2 md:grid-cols-[200px_1fr] md:gap-6 md:items-start">
          <span className="pt-2 text-sm font-medium">TLS</span>
          <label htmlFor="rotate-ssl-no-verify" className="flex items-start gap-2.5">
            <input
              id="rotate-ssl-no-verify"
              type="checkbox"
              name={noVerifyConfig.field}
              value="true"
              checked={sslNoVerify}
              onChange={(e) => setSslNoVerify(e.target.checked)}
              disabled={pending}
              className="mt-0.5 size-4 shrink-0 accent-foreground"
            />
            <span className="space-y-0.5">
              <span className="block text-sm font-medium">
                Connect without TLS certificate verification
              </span>
              <span className="block text-xs text-muted-foreground">
                Enable only for a database that presents a self-signed or private-CA certificate
                (e.g. {noVerifyConfig.examples}). Stays encrypted, but skips certificate-chain
                verification — use it only when you trust the network path. Appends{" "}
                <code className="font-mono">{noVerifyConfig.appended}</code> to the stored connection
                string.
              </span>
            </span>
          </label>
        </div>
      ) : null}

      <div className="flex items-center gap-3 border-t border-border pt-4">
        <Button type="submit" disabled={pending}>
          {pending ? "Rotating…" : "Save new credential"}
        </Button>
        <small className="text-xs text-muted-foreground">
          Stored encrypted (AES-256-GCM). The new fingerprint appears here on success.
        </small>
      </div>
    </form>
  );
}
