"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { MoreHorizontal } from "lucide-react";
import {
  deleteDestination,
  rotateDestinationCredentials,
  setDestinationStatus,
} from "../../../lib/destination-actions";
import type { ActionState } from "../../../lib/action-data";
import { schemaFor, type DestinationType } from "../../../lib/destination-defaults";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { ConfirmAction } from "../../_components/ConfirmAction";
import { useActionStateToast } from "../../_components/Toast";

/**
 * Per-row actions for a destination in the listing. Three forms in one
 * card so each action gets its own server-action call without page-level
 * state coupling.
 */
export function DestinationActions({
  destinationId,
  type,
  status,
  hasCredential,
  canDelete,
}: {
  destinationId: string;
  type: DestinationType;
  status: "active" | "disabled";
  hasCredential: boolean;
  canDelete: boolean;
}) {
  const router = useRouter();
  const [statusState, statusAction, statusPending] = useActionState<ActionState, FormData>(setDestinationStatus, {});
  const [rotateState, rotateAction, rotatePending] = useActionState<ActionState, FormData>(rotateDestinationCredentials, {});
  const [deleteState, deleteAction, deletePending] = useActionState<ActionState, FormData>(deleteDestination, {});
  const [rotateOpen, setRotateOpen] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  // The delete form lives outside the dropdown (its content unmounts on
  // select), so the confirm dialog submits it by ref.
  const deleteFormRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (statusState.notice && !statusState.error) router.refresh();
  }, [statusState.notice, statusState.error, router]);
  useEffect(() => {
    if (rotateState.notice && !rotateState.error) {
      router.refresh();
      setRotateOpen(false);
    }
  }, [rotateState.notice, rotateState.error, router]);
  useEffect(() => {
    if (deleteState.notice && !deleteState.error) router.refresh();
  }, [deleteState.notice, deleteState.error, router]);

  // Transient success outcomes surface as toasts; errors stay inline below.
  useActionStateToast({ notice: statusState.notice });
  useActionStateToast({ notice: rotateState.notice });
  useActionStateToast({ notice: deleteState.notice });

  const schema = schemaFor(type);
  const secretFields = schema.fields.filter((f) => f.kind === "secret");
  // "Connect without certificate verification" — postgres/mongodb only.
  const [sslNoVerify, setSslNoVerify] = useState(false);
  const noVerifyConfig =
    type === "postgres"
      ? { field: "pg_ssl_no_verify", appended: "sslmode=no-verify" }
      : type === "mongodb"
        ? { field: "mongo_tls_no_verify", appended: "tlsAllowInvalidCertificates=true" }
        : null;
  const targetStatus = status === "active" ? "disabled" : "active";
  const targetLabel = status === "active" ? "Disable" : "Enable";
  const errorMsg = statusState.error ?? rotateState.error ?? deleteState.error;

  return (
    <div className="flex flex-col items-end gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-8" aria-label="Destination actions">
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <form action={statusAction}>
            <input type="hidden" name="destination_id" value={destinationId} />
            <input type="hidden" name="status" value={targetStatus} />
            <DropdownMenuItem asChild>
              <button type="submit" disabled={statusPending} className="w-full">
                {statusPending ? "Working…" : targetLabel}
              </button>
            </DropdownMenuItem>
          </form>
          {hasCredential && secretFields.length > 0 ? (
            <DropdownMenuItem onSelect={() => setRotateOpen(true)}>
              Rotate credential
            </DropdownMenuItem>
          ) : null}
          {canDelete ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                disabled={deletePending}
                onSelect={() => setConfirmDeleteOpen(true)}
              >
                {deletePending ? "Deleting…" : "Delete"}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      {canDelete ? (
        <>
          <form action={deleteAction} ref={deleteFormRef} className="hidden">
            <input type="hidden" name="destination_id" value={destinationId} />
          </form>
          <ConfirmAction
            open={confirmDeleteOpen}
            onOpenChange={setConfirmDeleteOpen}
            title="Delete destination"
            body={`Permanently delete destination ${destinationId}? Routes will detach.`}
            confirmLabel="Delete"
            destructive
            onConfirm={() => deleteFormRef.current?.requestSubmit()}
          />
        </>
      ) : null}

      {errorMsg ? (
        <Alert variant="destructive" className="max-w-xs">
          <AlertDescription className="text-xs">{errorMsg}</AlertDescription>
        </Alert>
      ) : null}

      {hasCredential && secretFields.length > 0 ? (
        <Dialog
          open={rotateOpen}
          onOpenChange={(open) => {
            setRotateOpen(open);
            if (!open) setSslNoVerify(false);
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Rotate credential</DialogTitle>
              <DialogDescription>
                Encrypted at rest. The old value is unrecoverable after save.
              </DialogDescription>
            </DialogHeader>
            <form action={rotateAction} className="space-y-4">
              <input type="hidden" name="destination_id" value={destinationId} />
              <input type="hidden" name="type" value={type} />
              {secretFields.map((field) => (
                <div className="space-y-1.5" key={field.key}>
                  <Label htmlFor={`rotate-row-${field.key}`}>{field.label}</Label>
                  {field.inputType === "textarea" ? (
                    <Textarea
                      id={`rotate-row-${field.key}`}
                      name={field.key}
                      rows={5}
                      placeholder={field.placeholder ?? ""}
                      required={field.required !== false}
                      autoComplete="off"
                      spellCheck={false}
                      className="h-44 resize-y font-mono text-xs field-sizing-fixed"
                    />
                  ) : (
                    <Input
                      id={`rotate-row-${field.key}`}
                      name={field.key}
                      type={field.inputType ?? "password"}
                      placeholder={field.placeholder ?? ""}
                      required={field.required !== false}
                      autoComplete="new-password"
                    />
                  )}
                </div>
              ))}
              {noVerifyConfig ? (
                <label htmlFor="rotate-row-ssl-no-verify" className="flex items-start gap-2.5">
                  <input
                    id="rotate-row-ssl-no-verify"
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
                      For a self-signed / private-CA database (e.g. Railway). Stays encrypted but
                      skips certificate-chain verification. Appends{" "}
                      <code className="font-mono">{noVerifyConfig.appended}</code> to the connection
                      string.
                    </span>
                  </span>
                </label>
              ) : null}
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setRotateOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={rotatePending}>
                  {rotatePending ? "Rotating…" : "Save new credential"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
