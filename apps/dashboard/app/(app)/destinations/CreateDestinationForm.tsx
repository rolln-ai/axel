"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { CircleCheck, CircleAlert } from "lucide-react";
import { createDestination } from "../../../lib/destination-actions";
import type { ActionState } from "../../../lib/action-data";
import {
  testDestination,
  type TestDestinationResult,
} from "../../../lib/test-destination";
import {
  applyDestinationFieldValue,
  CREATABLE_DESTINATION_SCHEMAS,
  schemaFor,
  type DestinationType,
} from "../../../lib/destination-defaults";
import { ConditionalDestField } from "./ConditionalDestField";
import { CopyButton } from "../_components/CopyButton";
import { useToast } from "../../_components/Toast";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * Per-type destination create form. Type selector drives which field set
 * renders. All fields submit as form-data keys matching their schema key,
 * which the createDestination server action picks back up via
 * readDestinationValues.
 *
 * Special case — webhook signing secrets:
 *   When the customer creates a webhook destination without supplying a
 *   secret, the server generates one and returns the plaintext exactly once
 *   in `state.data.webhookSigningSecret`. This component renders a copy
 *   panel for that secret and signals to the parent dialog (via the
 *   `hasSecretToDisplay` callback arg) NOT to auto-dismiss. The plaintext
 *   never leaves this React state — once the dialog closes, it's gone.
 */
export function CreateDestinationForm({
  onSuccess,
}: {
  /** Called once after a successful create. Receives whether a secret is being shown. */
  onSuccess?: (info: { hasSecretToDisplay: boolean }) => void;
} = {}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(createDestination, {});
  // Default to "webhook" — it's the recommended type for production
  // receivers, and ordering CREATABLE_DESTINATION_SCHEMAS puts it first too.
  const [type, setType] = useState<DestinationType>("webhook");
  const schema = schemaFor(type);
  // Controlled so a submit error doesn't wipe the form — React 19 resets
  // uncontrolled fields after a form action completes (even on error).
  // `name` is type-independent, so it survives a type switch (unlike the
  // per-type field values, which reset below).
  const [name, setName] = useState("");
  const generatedSecret = state.data?.webhookSigningSecret;
  // AXE-33 — track field values so `showWhen` conditional rendering
  // re-evaluates as the user picks an auth_type / preset. Preset picks also
  // apply their implied auth defaults (applyDestinationFieldValue).
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const setFieldValue = (key: string, value: string) =>
    setFieldValues((prev) => applyDestinationFieldValue(prev, key, value));
  // "Connect without certificate verification" — only meaningful for Postgres,
  // where it appends sslmode=no-verify to the persisted DSN.
  const [sslNoVerify, setSslNoVerify] = useState(false);
  useEffect(() => {
    // Reset field state when the type changes (Mongo/PG/HTTP have
    // disjoint schemas — keeping stale values would be confusing).
    setFieldValues({});
    setSslNoVerify(false);
  }, [type]);

  // Test-connection state lives separately from the create state — it's a
  // pre-flight read-only probe and shouldn't replace the form's submit
  // semantics. Reset whenever the user switches type since the result is
  // tied to the field set the probe ran against.
  const formRef = useRef<HTMLFormElement>(null);
  const [testResult, setTestResult] = useState<TestDestinationResult | null>(null);
  const [testing, startTesting] = useTransition();
  useEffect(() => {
    setTestResult(null);
  }, [type]);

  function handleTest() {
    if (!formRef.current) return;
    const data = new FormData(formRef.current);
    startTesting(async () => {
      const result = await testDestination(data);
      setTestResult(result);
    });
  }

  // Notify the parent (typically a dialog) of the success outcome so it can
  // decide whether to auto-dismiss. We key only on `state.notice` changing.
  useEffect(() => {
    if (state.notice && !state.error && onSuccess) {
      onSuccess({ hasSecretToDisplay: Boolean(generatedSecret) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.notice]);

  // After a webhook destination is created we lock the form and just show
  // the secret panel — submitting again would be confusing (it'd create a
  // second destination instead of refining the current one).
  if (generatedSecret) {
    const destinationId = state.data?.destinationId;
    return (
      <WebhookSecretReveal
        secret={generatedSecret}
        {...(destinationId ? { destinationId } : {})}
      />
    );
  }

  // Per-type config for the "connect without certificate verification" toggle —
  // only the DB destinations negotiate TLS, and each carries a different opt-out
  // form field + connection-string option (see withNoVerifySslMode /
  // withMongoTlsNoVerify).
  const noVerifyConfig =
    type === "postgres"
      ? { field: "pg_ssl_no_verify", examples: "Railway, Heroku Postgres", appended: "sslmode=no-verify" }
      : type === "mongodb"
        ? { field: "mongo_tls_no_verify", examples: "a self-hosted replica set", appended: "tlsAllowInvalidCertificates=true" }
        : null;

  return (
    <form ref={formRef} action={formAction} className="space-y-5">
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

      <div className="space-y-1.5">
        <Label htmlFor="dest-type">Destination type</Label>
        <input type="hidden" name="type" value={type} />
        <Select value={type} onValueChange={(value) => setType(value as DestinationType)}>
          <SelectTrigger id="dest-type" className="h-10 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" align="start">
            {CREATABLE_DESTINATION_SCHEMAS.map((s) => (
              <SelectItem key={s.type} value={s.type}>
                <span className="text-muted-foreground" aria-hidden="true">
                  {s.glyph}
                </span>
                <span>{s.label}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{schema.blurb}</p>
      </div>

      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="dest-name">Name</Label>
          <Input
            id="dest-name"
            name="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={`prod-${schema.type}`}
            required
            minLength={2}
            maxLength={64}
            autoComplete="off"
          />
          <p className="text-xs text-muted-foreground">
            2–64 chars: letters, numbers, spaces, and . _ -. Used as a label only.
          </p>
        </div>

        {schema.fields.map((field) => (
          <ConditionalDestField
            key={field.key}
            field={field}
            type={type}
            fieldValues={fieldValues}
            setFieldValue={setFieldValue}
          />
        ))}

        {noVerifyConfig ? (
          <div
            className={`rounded-md border p-3 ${
              testResult?.certError && !sslNoVerify
                ? "border-amber-500/60 bg-amber-500/5"
                : "border-border"
            }`}
          >
            <label htmlFor="dest-ssl-no-verify" className="flex items-start gap-2.5">
              <input
                id="dest-ssl-no-verify"
                type="checkbox"
                name={noVerifyConfig.field}
                value="true"
                checked={sslNoVerify}
                onChange={(e) => setSslNoVerify(e.target.checked)}
                className="mt-0.5 size-4 shrink-0 accent-foreground"
              />
              <span className="space-y-0.5">
                <span className="block text-sm font-medium">
                  Connect without TLS certificate verification
                </span>
                <span className="block text-xs text-muted-foreground">
                  Enable only for a database that presents a self-signed or private-CA certificate
                  (e.g. {noVerifyConfig.examples}). The connection stays encrypted, but Axel
                  won&apos;t verify the certificate chain — use it only when you trust the network
                  path to the database. Appends{" "}
                  <code className="font-mono">{noVerifyConfig.appended}</code> to the stored
                  connection string.
                </span>
              </span>
            </label>
          </div>
        ) : null}
      </div>

      {testResult ? (
        <Alert variant={testResult.ok ? "default" : "destructive"}>
          <AlertDescription className="flex items-start gap-2">
            {testResult.ok ? (
              <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <CircleAlert className="mt-0.5 size-4 shrink-0" />
            )}
            <span>{testResult.message}</span>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button
          type="button"
          variant="outline"
          onClick={handleTest}
          disabled={pending || testing}
          className="sm:w-44"
        >
          {testing ? "Testing…" : "Test connection"}
        </Button>
        <Button type="submit" disabled={pending || testing} className="flex-1">
          {pending ? "Creating…" : `Create ${schema.label}`}
        </Button>
      </div>
    </form>
  );
}

/**
 * One-time reveal panel for the auto-generated webhook signing secret.
 * Mirrors the source-token reveal pattern: shown once, manual copy, and the
 * customer must rotate via the destination detail page if they lose it.
 */
function WebhookSecretReveal({ secret, destinationId }: { secret: string; destinationId?: string }) {
  return (
    <div className="space-y-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4">
      <p className="text-sm text-foreground">
        Webhook destination created{destinationId ? ` (${destinationId})` : ""}. This signing secret
        is shown <strong className="font-semibold">once</strong> — copy it now. Rotate from the
        destination detail page if needed.
      </p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-sm bg-muted px-2 py-1 font-mono text-xs">
          {secret}
        </code>
        <SecretCopyButton secret={secret} />
      </div>
      <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
        <li>Send the secret to the receiver out of band (1Password, env var, etc.).</li>
        <li>
          Receivers verify{" "}
          <code className="font-mono">HMAC-SHA256(secret, &quot;&lt;timestamp&gt;.&lt;body&gt;&quot;)</code>{" "}
          against the <code className="font-mono">X-Axel-Signature</code> header.
        </li>
        <li>Reject any request where <code className="font-mono">|now − timestamp|</code> exceeds 5 minutes.</li>
      </ul>
    </div>
  );
}

function SecretCopyButton({ secret }: { secret: string }) {
  const toast = useToast();
  return (
    <CopyButton
      value={secret}
      variant="ghost"
      size="sm"
      className="h-7 shrink-0 text-xs"
      onCopyError={() =>
        // The secret is shown once — a silent copy failure means a permanently
        // lost secret. Tell the user to copy it by hand.
        toast.error("Couldn't copy to the clipboard. Select the secret text and copy it manually.")
      }
    />
  );
}
