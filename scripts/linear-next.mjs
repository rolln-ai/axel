#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  config,
  issueNumber,
  labels,
  linear,
} from "./linear-api.mjs";

const shouldStart = process.argv.includes("--start");
const asJson = process.argv.includes("--json");

const data = await linear(
  `query ProjectIssues($projectId: ID!) {
    issues(first: 100, filter: { project: { id: { eq: $projectId } } }) {
      nodes {
        id
        identifier
        title
        url
        priority
        createdAt
        updatedAt
        state { name type }
        projectMilestone { name }
        labels { nodes { name } }
      }
    }
  }`,
  { projectId: config.projectId },
);

const repoLabel = config.primaryRepoLabel;
const blockedLabels = new Set(config.blockedLabels ?? []);
const eligibleStateNames = new Set(config.eligibleStateNames ?? ["Ready", "Triage", "Backlog"]);
const preferredMilestones = new Set(config.preferredMilestones ?? []);
const stateRank = new Map([
  ["Ready", 0],
  ["Triage", 20],
  ["Backlog", 40],
]);
const milestoneRank = new Map((config.preferredMilestones ?? []).map((name, index) => [name, index * 10]));

function isEligible(issue) {
  const names = labels(issue);
  if (!names.has(repoLabel)) return false;
  if ([...blockedLabels].some((label) => names.has(label))) return false;
  if (!eligibleStateNames.has(issue.state?.name ?? "")) return false;
  return !["completed", "canceled", "duplicate"].includes(issue.state?.type ?? "");
}

function score(issue) {
  const names = labels(issue);
  const priority = issue.priority && issue.priority > 0 ? issue.priority : 4;
  const milestoneName = issue.projectMilestone?.name;
  const milestoneFit =
    preferredMilestones.size === 0 || preferredMilestones.has(milestoneName)
      ? -20
      : 60;

  return (
    (stateRank.get(issue.state?.name) ?? 50) +
    priority * 10 +
    (milestoneRank.get(milestoneName) ?? 50) +
    milestoneFit +
    (names.has("launch-critical") ? -35 : 0) +
    (names.has("client-feedback") ? -15 : 0) +
    (names.has("codex-ready") ? -5 : 0) +
    issueNumber(issue) / 1000
  );
}

const eligible = data.issues.nodes
  .filter(isEligible)
  .map((issue) => ({
    ...issue,
    labelNames: [...labels(issue)],
    score: score(issue),
  }))
  .sort((a, b) => a.score - b.score || issueNumber(a) - issueNumber(b));

if (eligible.length === 0) {
  console.error(`No eligible next issue found for ${repoLabel}.`);
  process.exit(2);
}

const next = eligible[0];
const runnersUp = eligible.slice(1, 4);

if (asJson) {
  console.log(JSON.stringify({ next, runnersUp }, null, 2));
} else {
  console.log(`${next.identifier}: ${next.title}`);
  console.log(next.url);
  console.log(`State: ${next.state.name}`);
  console.log(`Milestone: ${next.projectMilestone?.name ?? "None"}`);
  console.log(`Labels: ${next.labelNames.join(", ")}`);
  if (runnersUp.length) {
    console.log("\nRunners up:");
    for (const issue of runnersUp) {
      console.log(`- ${issue.identifier}: ${issue.title}`);
    }
  }
  console.log("\nStart it: pnpm linear:next --start");
}

if (shouldStart) {
  execFileSync("node", ["scripts/linear-start.mjs", next.identifier], {
    stdio: "inherit",
  });
}
