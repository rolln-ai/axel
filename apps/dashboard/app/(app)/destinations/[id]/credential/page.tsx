import { notFound, redirect } from "next/navigation";
import { requireSession } from "../../../../../lib/session";
import { getDestinationSummary } from "../../../../../lib/destination-inspect";
import { RotateCredentialForm } from "../RotateCredentialForm";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export default async function DestinationCredentialPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requireSession();
  const canMutate = session.activeWorkspace.role === "owner" || session.activeWorkspace.role === "admin";
  if (!canMutate) redirect(`/destinations/${id}`);

  const destination = await getDestinationSummary(id, session.activeWorkspace.workspace_id);
  if (!destination) notFound();

  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <h2 className="text-sm font-semibold text-foreground">Rotate credential</h2>
        <Badge variant="outline">encrypted at rest · old value unrecoverable</Badge>
      </div>
      <div className="space-y-3 p-5">
        <RotateCredentialForm
          destinationId={destination.id}
          type={destination.type}
          fingerprintLast4={destination.fingerprint_last4}
          fingerprintSha256Prefix={destination.fingerprint_sha256_prefix}
        />
      </div>
    </section>
  );
}
