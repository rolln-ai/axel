#!/usr/bin/env node
import { readFileSync } from "node:fs";
import {
  config,
  createIssueComment,
  extractIssueKey,
  updateIssueState,
} from "./linear-api.mjs";

const statusArg = process.argv.find((arg) => arg.startsWith("--status="));
const status = statusArg?.split("=")[1];
if (!["success", "failure"].includes(status)) {
  console.error("Usage: node scripts/linear-deploy-sync.mjs --status=success|failure");
  process.exit(2);
}

const eventPath = process.env.GITHUB_EVENT_PATH;
if (!eventPath) {
  console.error("GITHUB_EVENT_PATH is required.");
  process.exit(2);
}

const event = JSON.parse(readFileSync(eventPath, "utf8"));
const candidates = [
  event.head_commit?.message,
  ...(event.commits ?? []).flatMap((commit) => [commit.message, commit.id]),
];
const issueKeys = [...new Set(candidates.map((value) => extractIssueKey(value)).filter(Boolean))];

if (issueKeys.length === 0) {
  console.log("No Linear issue keys found in push event.");
  process.exit(0);
}

const runUrl =
  process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : "GitHub Actions";

for (const issueKey of issueKeys) {
  const stateName =
    status === "success"
      ? config.workflowStates?.deployed
      : config.workflowStates?.blocked;
  await updateIssueState(issueKey, stateName);
  await createIssueComment(
    issueKey,
    status === "success"
      ? `Production smoke tests passed after merge. Marked deployed.\n\n${runUrl}`
      : `Production smoke tests failed after merge. Marked blocked for follow-up.\n\n${runUrl}`,
  );
  console.log(`${issueKey} deploy sync: ${status}`);
}
