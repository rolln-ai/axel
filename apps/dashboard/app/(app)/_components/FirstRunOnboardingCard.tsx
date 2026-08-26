import * as React from "react";
import { Cable, GitBranch, Send, Sparkles } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/**
 * First-run onboarding for a workspace with zero sources. Teaches the
 * source → route → destination model in three lines, then hands off to the
 * existing source+pipeline wizard via the injected `trigger`.
 *
 * Pure presentational (no hooks, server-safe): the wizard owns its own open
 * state, so this renders fine straight from the server pages. Gating
 * (sources.length === 0 && canMutate) lives in the parent so viewers and
 * non-empty workspaces never see it.
 */
const STEPS: Array<{ icon: typeof Cable; label: string; body: string }> = [
  {
    icon: Cable,
    label: "Source",
    body: "Where events come from — a signed or token-authenticated inbound webhook.",
  },
  {
    icon: GitBranch,
    label: "Route",
    body: "Optional filter or transform; decides which events pass and reshapes them.",
  },
  {
    icon: Send,
    label: "Destination",
    body: "Where routed events land — HTTP, Postgres, a warehouse, etc. Optional at first: events are stored either way, and you can replay them once a destination exists.",
  },
];

export function FirstRunOnboardingCard({ trigger }: { trigger: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Set up your first pipeline</CardTitle>
        <CardDescription>
          Route events through Axel in three steps: a source receives them, a route decides what
          passes, a destination is where they land.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="flex flex-col gap-3">
          {STEPS.map(({ icon: Icon, label, body }) => (
            <li key={label} className="flex items-start gap-3">
              <span
                className="grid size-8 shrink-0 place-items-center rounded-full bg-primary/10"
                aria-hidden="true"
              >
                <Icon className="size-4 text-primary" />
              </span>
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-wide text-foreground">
                  {label}
                </p>
                <p className="mt-0.5 text-sm text-muted-foreground">{body}</p>
              </div>
            </li>
          ))}
        </ol>
      </CardContent>
      <CardFooter className="flex-wrap justify-between gap-3">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Sparkles className="size-3.5" aria-hidden="true" />
          Takes about a minute — you only need a name. Send a test event with one click at the end;
          connect your provider and destination whenever you like.
        </span>
        {trigger}
      </CardFooter>
    </Card>
  );
}
