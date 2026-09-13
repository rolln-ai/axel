import { PageHeader } from "@/app/_components/PageHeader";
import { Section } from "@/app/_components/Section";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireSuperAdmin } from "@/lib/admin-auth";
import { getGrowthReport } from "@/lib/admin-growth";

export const dynamic = "force-dynamic";
const labels = { github: "GitHub", website: "Website", unknown: "Unknown / direct" };

export default async function GrowthPage() {
  await requireSuperAdmin();
  const report = await getGrowthReport();
  return (
    <>
      <PageHeader eyebrow="Admin" title="Cloud adoption" description="New workspaces in the last 28 days, grouped by the link used to sign up." />
      <Section title="Signup to delivery">
        {!report.available && <p role="status" className="text-sm text-muted-foreground">Event analytics are unavailable. Signup counts are still shown.</p>}
        {report.truncated && <p role="status" className="text-sm text-muted-foreground">Showing the most recent 1,000 workspaces in this period.</p>}
        <Table>
          <TableHeader><TableRow>
            <TableHead scope="col">Signup source</TableHead>
            <TableHead scope="col">Workspaces</TableHead>
            <TableHead scope="col">Received in week 1</TableHead>
            <TableHead scope="col">Delivered in week 1</TableHead>
            <TableHead scope="col">Received again in week 2</TableHead>
          </TableRow></TableHeader>
          <TableBody>{report.cohorts.map((row) => (
            <TableRow key={row.source}>
              <TableHead scope="row">{labels[row.source]}</TableHead>
              <TableCell className="font-mono">{row.signups}</TableCell>
              <TableCell className="font-mono">{report.available ? row.received : "Unavailable"}</TableCell>
              <TableCell className="font-mono">{report.available ? row.delivered : "Unavailable"}</TableCell>
              <TableCell className="font-mono">{!report.available ? "Unavailable" : row.eligible ? `${row.continued} / ${row.eligible}` : "No eligible workspaces"}</TableCell>
            </TableRow>
          ))}</TableBody>
        </Table>
        <p className="text-xs text-muted-foreground">Week 1 is the first seven days after signup. Newer workspaces are still accumulating events. Week 2 counts only workspaces at least 14 days old that received and successfully delivered an event in week 1.</p>
      </Section>
      <Section title="What these numbers include">
        <p className="text-sm text-muted-foreground">Test events, deleted workspaces, and billing-exempt internal workspaces are excluded. One successful destination delivery is enough to count a workspace as delivered.</p>
        <p className="text-sm text-muted-foreground">Signup sources are labels on our links, not verified referrers. Older accounts and unlabelled links appear under Unknown / direct. No referral URLs, tracking cookies, or third-party analytics are collected for this report.</p>
      </Section>
    </>
  );
}
