import { notFound, redirect } from "next/navigation";
import { requireSession } from "../../../../../lib/session";
import { getDestinationSummary } from "../../../../../lib/destination-inspect";
import { EditDestinationForm } from "../EditDestinationForm";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export default async function DestinationConfigurationPage({
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
        <h2 className="text-sm font-semibold text-foreground">Edit configuration</h2>
        <Badge variant="outline">config fields only — secrets rotate separately</Badge>
      </div>
      <div className="space-y-3 p-5">
        <EditDestinationForm
          destinationId={destination.id}
          type={destination.type}
          name={destination.name}
          config={destination.config}
        />
      </div>
    </section>
  );
}
