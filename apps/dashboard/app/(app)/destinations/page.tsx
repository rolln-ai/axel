import Link from "@/app/_components/NavigationLink";
import { EmptyState } from "../../EmptyState";
import { PageHeader } from "../../_components/PageHeader";
import { EntityStatusBadge } from "../../_components/StatusBadges";
import { NewDestinationDialog } from "./NewDestinationDialog";
import { DestinationActions } from "./DestinationActions";
import { DestinationQuickView } from "./DestinationQuickView";
import { db } from "../../../lib/db";
import { listDestinationsWithRouteCount } from "../../../lib/destinations";
import { isCredentialsMasterKeyConfigured } from "../../../lib/credentials";
import { schemaFor, type DestinationType } from "../../../lib/destination-defaults";
import { requireSession } from "../../../lib/session";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const dynamic = "force-dynamic";

export default async function DestinationsPage() {
  const session = await requireSession();
  const canMutate = session.activeWorkspace.role === "owner" || session.activeWorkspace.role === "admin";
  const canDelete = session.activeWorkspace.role === "owner";
  const masterKeyConfigured = isCredentialsMasterKeyConfigured();
  const destinations = await listDestinationsWithRouteCount(session.activeWorkspace.workspace_id, db());

  // Reasons we'd grey out the "+ New destination" button rather than letting
  // the user open a modal that immediately fails. Mirrors the routes page.
  const newDestinationDisabledReason = !canMutate
    ? "Owners and admins can create destinations"
    : !masterKeyConfigured
      ? "Server is missing CREDENTIALS_MASTER_KEY"
      : undefined;

  return (
    <>
      <PageHeader
        eyebrow="Workspace"
        title="Destinations"
        description="Where events land — Mongo, Postgres, S3, R2, signed webhooks. Each destination has its own encrypted credential and per-row delivery health."
        actions={
          canMutate ? (
            <NewDestinationDialog
              {...(newDestinationDisabledReason ? { disabledReason: newDestinationDisabledReason } : {})}
            />
          ) : null
        }
      />

      {!masterKeyConfigured ? (
        <Alert variant="destructive" className="mb-6">
          <AlertDescription>
            <strong className="font-semibold">Server is missing CREDENTIALS_MASTER_KEY.</strong>{" "}
            Create-destination is disabled. The dashboard needs{" "}
            <code className="rounded-sm bg-muted px-1 font-mono text-xs">CREDENTIALS_MASTER_KEY</code>{" "}
            set as a Vercel environment variable before it can encrypt destination credentials.
            Generate one with{" "}
            <code className="rounded-sm bg-muted px-1 font-mono text-xs">openssl rand -hex 32</code>{" "}
            and set the same value on the{" "}
            <code className="rounded-sm bg-muted px-1 font-mono text-xs">axel-delivery-edge</code>{" "}
            Cloudflare Worker (via{" "}
            <code className="rounded-sm bg-muted px-1 font-mono text-xs">wrangler secret put</code>)
            and the{" "}
            <code className="rounded-sm bg-muted px-1 font-mono text-xs">axel-delivery-native</code>{" "}
            Render service.
          </AlertDescription>
        </Alert>
      ) : null}

      <section className="rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold text-foreground">{destinations.length} configured</h2>
        </div>
        {destinations.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Config</TableHead>
                <TableHead>Credential</TableHead>
                <TableHead>Routes</TableHead>
                <TableHead>Status</TableHead>
                {canMutate ? <TableHead className="text-right">Actions</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {destinations.map((dest) => (
                <TableRow key={dest.id}>
                  <TableCell>
                    <Link href={`/destinations/${dest.id}`} className="block">
                      <strong className="text-sm font-medium text-foreground">
                        {dest.name ?? "(unnamed)"}
                      </strong>
                      <small className="block font-mono text-[11px] text-muted-foreground">
                        {dest.id}
                      </small>
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Link href={`/destinations/${dest.id}`} className="block">
                      <code className="rounded-sm bg-muted px-1 font-mono text-xs">{dest.type}</code>
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Link href={`/destinations/${dest.id}`} className="block">
                      <DestinationConfigSummary type={dest.type} config={dest.config} />
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Link href={`/destinations/${dest.id}`} className="block">
                      {dest.fingerprint_last4 ? (
                        <code className="font-mono text-[11px]">
                          •••{dest.fingerprint_last4}{" "}
                          <small className="text-muted-foreground">
                            {dest.fingerprint_sha256_prefix}
                          </small>
                        </code>
                      ) : (
                        <small className="text-muted-foreground">none</small>
                      )}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Link href={`/destinations/${dest.id}`} className="block text-sm">
                      {dest.routes_attached}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Link href={`/destinations/${dest.id}`} className="block">
                      <EntityStatusBadge status={dest.status} className="capitalize" />
                    </Link>
                  </TableCell>
                  {canMutate ? (
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <DestinationQuickView
                          destination={{
                            id: dest.id,
                            name: dest.name,
                            type: dest.type,
                            status: dest.status,
                            config: dest.config,
                            fingerprint_last4: dest.fingerprint_last4,
                            fingerprint_sha256_prefix: dest.fingerprint_sha256_prefix,
                            routes_attached: dest.routes_attached,
                            created_at: dest.created_at,
                          }}
                        />
                        <DestinationActions
                          destinationId={dest.id}
                          type={dest.type}
                          status={dest.status}
                          hasCredential={dest.fingerprint_last4 !== null}
                          canDelete={canDelete}
                        />
                      </div>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <div className="p-5">
            <EmptyState
              title="No destinations yet"
              body={canMutate
                ? "Click \u201C+ New destination\u201D above to add one. Pick the type, fill in the connection details, and Axel encrypts the secrets before they hit the database."
                : "Once an owner or admin creates a destination, it will appear here."}
            />
          </div>
        )}
      </section>
    </>
  );
}

function DestinationConfigSummary({
  type,
  config,
}: {
  type: DestinationType;
  config: Record<string, unknown>;
}) {
  const schema = schemaFor(type);
  const items = schema.fields
    .filter((f) => f.kind === "config")
    .map((f) => ({ label: f.label, value: config[f.key] }))
    .filter((i): i is { label: string; value: string | number } =>
      typeof i.value === "string" || typeof i.value === "number");
  if (items.length === 0) return <small className="text-muted-foreground">—</small>;
  return (
    <ul className="m-0 list-none space-y-0.5 p-0 text-xs leading-snug">
      {items.slice(0, 3).map((item) => (
        <li key={item.label}>
          <small className="text-muted-foreground">{item.label}: </small>
          <code className="font-mono">{String(item.value).slice(0, 48)}</code>
        </li>
      ))}
    </ul>
  );
}
