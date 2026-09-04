import { redirect } from "next/navigation";
import { PageHeader } from "../../_components/PageHeader";
import { FirstRunSetupFlow } from "../_components/FirstRunSetupFlow";
import { listSourcesCached } from "../../../lib/repositories";
import { requireSession } from "../../../lib/session";
import { resolveIngestBaseUrl } from "@axel/shared";
import type { SourceProvider } from "@axel/shared";

export const dynamic = "force-dynamic";

/**
 * First-run setup, on its own route by necessity (ROL-457).
 *
 * This used to render inside the dashboard's `sources.length === 0` branch.
 * Creating a source revalidates the sources cache tag, which flipped that gate
 * and unmounted the flow mid-setup — dropping the user on an empty dashboard
 * with the one-shot ingest token lost. Here the flow keeps its position in the
 * tree across revalidation, so its client state (and that token) survive.
 *
 * The page therefore must NOT gate on "workspace is empty" — it stays
 * reachable after the first source exists.
 */
export default async function SetupPage() {
  const session = await requireSession();
  const canMutate =
    session.activeWorkspace.role === "owner" || session.activeWorkspace.role === "admin";
  // Viewers can't create anything; there's nothing for them to do here.
  if (!canMutate) redirect("/dashboard");

  const ingestBase = resolveIngestBaseUrl(process.env);
  let existingSource: {
    id: string;
    name: string;
    ingestUrl: string;
    provider: SourceProvider;
  } | undefined;
  try {
    const sources = await listSourcesCached(session.activeWorkspace.workspace_id);
    // Newest webhook source (listSources is created_at DESC). Lets a reloaded
    // page resume at step 2 with a working endpoint — the plaintext token is
    // gone by then, which the flow explains and offers rotation for.
    const latest = sources.find((s) => s.source_kind === "webhook");
    if (latest) {
      existingSource = {
        id: latest.id,
        name: latest.name,
        ingestUrl: `${ingestBase}/in/${latest.id}`,
        provider: latest.provider,
      };
    }
  } catch {
    // Sources lookup unavailable — start the flow from scratch rather than
    // failing the page; creating a source still works.
  }

  return (
    <>
      <PageHeader
        eyebrow="Workspace setup"
        title={`Welcome to ${session.activeWorkspace.workspace_name}`}
        description="Three steps: create a source, point your webhook at it, then send those events somewhere."
      />
      <section className="mx-auto mt-8 max-w-2xl" aria-label="Workspace setup">
        <FirstRunSetupFlow existingSource={existingSource} />
      </section>
    </>
  );
}
