#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertRepoIssue,
  config,
  createIssueComment,
  getIssue,
  labels,
  slugify,
  updateIssueState,
} from "./linear-api.mjs";

const issueKey = (process.argv[2] || "").toUpperCase();
if (!/^ROL-\d+$/.test(issueKey)) {
  console.error("Usage: pnpm linear:start ROL-123");
  process.exit(1);
}

const issue = await getIssue(issueKey);
assertRepoIssue(issue);

const branch = `${config.branchPrefix}/${issue.identifier.toLowerCase()}-${slugify(issue.title)}`;
execFileSync("git", ["checkout", "-B", branch], { stdio: "inherit" });

mkdirSync(".linear", { recursive: true });
writeFileSync(
  join(".linear", "current-issue.md"),
  `# ${issue.identifier}: ${issue.title}

${issue.url}

State: ${issue.state?.name ?? "Unknown"}
Project: ${issue.project?.name ?? config.projectName}
Milestone: ${issue.projectMilestone?.name ?? "None"}
Labels: ${[...labels(issue)].join(", ")}

## Description

${issue.description ?? ""}
`,
);

await updateIssueState(issue.identifier, config.workflowStates?.started);
await createIssueComment(
  issue.identifier,
  `Started local work from \`${branch}\`.\n\nNext steps: implement, run verification, open a PR titled \`${issue.identifier}: ${issue.title}\`, then enable auto-merge after checks pass.`,
);

console.log(`Started ${issue.identifier}`);
console.log(`Branch: ${branch}`);
console.log("Context: .linear/current-issue.md");
