"use client";

import { useActionState } from "react";
import { BookOpen, ExternalLink } from "lucide-react";
import {
  createWorkspaceApiKeyAction,
  revokeWorkspaceApiKeyAction,
} from "../../../lib/workspace-settings-actions";
import type { ActionState } from "../../../lib/action-data";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CopyableSecret } from "../_components/CopyButton";
import { ConfirmAction } from "../../_components/ConfirmAction";
import { LocalTime } from "../../_components/LocalTime";

interface ApiKeyListRow {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

/**
 * AXE-29 — workspace API key management. List + create + revoke.
 * Plaintext shown ONCE in a one-shot reveal panel after create.
 */
export function ApiKeysPanel({
  initialKeys,
  canManage,
}: {
  initialKeys: ApiKeyListRow[];
  canManage: boolean;
}) {
  const [createState, createAction, creating] = useActionState<ActionState, FormData>(
    createWorkspaceApiKeyAction,
    {},
  );
  const [revokeState, revokeAction, revoking] = useActionState<ActionState, FormData>(
    revokeWorkspaceApiKeyAction,
    {},
  );
  const plaintext = createState.data?.plaintextToken;
  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 rounded-md border border-border bg-muted/30 p-3 text-sm">
        <div className="flex items-start gap-2">
          <BookOpen className="mt-0.5 size-4 text-muted-foreground" aria-hidden />
          <div>
            <p className="font-medium text-foreground">API reference</p>
            <p className="text-xs text-muted-foreground">
              Endpoint shapes, scopes, and error codes for <code>/api/v1/*</code>
              and the ingest endpoint.
            </p>
          </div>
        </div>
        <Button asChild size="sm" variant="outline">
          <a href="/docs/api" target="_blank" rel="noreferrer">
            View docs <ExternalLink className="ml-1 size-3" aria-hidden />
          </a>
        </Button>
      </div>

      {canManage ? (
        <form action={createAction} className="space-y-3 rounded-md border border-dashed border-border p-4">
          <h3 className="text-sm font-semibold text-foreground">Create API key</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="api-key-name">Name</Label>
              <Input
                id="api-key-name"
                name="name"
                placeholder="ci-deploy-pipeline"
                minLength={2}
                maxLength={64}
                required
              />
            </div>
            <fieldset className="space-y-1.5">
              <legend className="text-sm font-medium">Scopes</legend>
              <div className="flex flex-wrap gap-3 text-xs">
                {(["read", "write", "replay", "admin"] as const).map((scope) => (
                  <label key={scope} className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      name="scopes"
                      value={scope}
                      defaultChecked={scope === "read"}
                      className="size-3.5"
                    />
                    <span className="capitalize">{scope}</span>
                  </label>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">
                <code>write</code> implies <code>read</code>; <code>admin</code> implies all
                others. Pick the narrowest set that works for the integration.
              </p>
            </fieldset>
          </div>
          {createState.error ? (
            <Alert variant="destructive"><AlertDescription>{createState.error}</AlertDescription></Alert>
          ) : null}
          {plaintext ? (
            <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950">
              <p className="font-medium text-amber-900 dark:text-amber-100">
                Copy now — this is shown ONCE.
              </p>
              <CopyableSecret value={plaintext} noun="key" appearance="panel" />
              <p className="text-xs text-amber-900 dark:text-amber-100">
                Use in <code>Authorization: Bearer {plaintext}</code> against
                <code className="ml-1">/api/v1/*</code>.
              </p>
            </div>
          ) : null}
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={creating}>
              {creating ? "Creating…" : "Create key"}
            </Button>
          </div>
        </form>
      ) : null}

      {revokeState.error ? (
        <Alert variant="destructive"><AlertDescription>{revokeState.error}</AlertDescription></Alert>
      ) : null}
      {revokeState.notice ? (
        <Alert><AlertDescription>{revokeState.notice}</AlertDescription></Alert>
      ) : null}

      <div className="rounded-md border border-border">
        <table className="w-full text-sm">
          <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium">Key</th>
              <th className="px-3 py-2 font-medium">Scopes</th>
              <th className="px-3 py-2 font-medium">Last used</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {initialKeys.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-4 text-center text-xs text-muted-foreground">
                  No API keys yet. Create one above to start using <code>/api/v1/*</code>.
                </td>
              </tr>
            ) : (
              initialKeys.map((k) => (
                <tr key={k.id} className="border-t border-border">
                  <td className="px-3 py-2 font-medium text-foreground">{k.name}</td>
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                    {k.key_prefix}…
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {k.scopes.map((s) => (
                        <span
                          key={s}
                          className="rounded-sm bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase"
                        >
                          {s}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {k.last_used_at ? <LocalTime value={k.last_used_at} /> : "never"}
                  </td>
                  <td className="px-3 py-2">
                    {k.revoked_at ? (
                      <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase text-red-700 dark:text-red-400">
                        revoked
                      </span>
                    ) : (
                      <span className="rounded-full bg-green-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase text-green-700 dark:text-green-400">
                        active
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {canManage && !k.revoked_at ? (
                      <form action={revokeAction}>
                        <input type="hidden" name="key_id" value={k.id} />
                        <ConfirmAction
                          title="Revoke API key"
                          body="Revoke this API key? Anything using it stops working immediately."
                          confirmLabel="Revoke"
                          destructive
                        >
                          <Button type="button" size="sm" variant="ghost" disabled={revoking}>
                            Revoke
                          </Button>
                        </ConfirmAction>
                      </form>
                    ) : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
