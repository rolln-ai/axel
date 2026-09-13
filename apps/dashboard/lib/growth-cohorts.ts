import { SIGNUP_SOURCES, signupSource, type SignupSource } from "./signup-source";

export interface GrowthWorkspace {
  id: string;
  created_at: string;
  signup_source: string;
}
export interface GrowthActivity {
  workspace_id: string;
  received_first_week: number;
  received_second_week: number;
  delivered_first_week: number;
}
export interface GrowthCohort {
  source: SignupSource;
  signups: number;
  received: number;
  delivered: number;
  eligible: number;
  continued: number;
}

export function growthCohorts(workspaces: GrowthWorkspace[], activity: GrowthActivity[], now: number): GrowthCohort[] {
  const byWorkspace = new Map(activity.map((row) => [row.workspace_id, row]));
  const cohorts = SIGNUP_SOURCES.map((source) => ({ source, signups: 0, received: 0, delivered: 0, eligible: 0, continued: 0 }));
  for (const workspace of workspaces) {
    const cohort = cohorts.find((row) => row.source === signupSource(workspace.signup_source));
    if (!cohort) continue;
    cohort.signups++;
    const row = byWorkspace.get(workspace.id);
    if (!row?.received_first_week) continue;
    cohort.received++;
    if (!row.delivered_first_week) continue;
    cohort.delivered++;
    if (now - Date.parse(workspace.created_at) < 14 * 86_400_000) continue;
    cohort.eligible++;
    if (row.received_second_week) cohort.continued++;
  }
  return cohorts;
}
