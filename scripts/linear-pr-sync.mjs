#!/usr/bin/env node
import { readFileSync } from "node:fs";
import {
  assertRepoIssue,
  config,
  createIssueComment,
  extractIssueKey,
  getIssue,
  updateIssueState,
} from "./linear-api.mjs";

const eventPath = process.env.GITHUB_EVENT_PATH;
if (!eventPath) {
  console.error("GITHUB_EVENT_PATH is required.");
  process.exit(2);
}

const event = JSON.parse(readFileSync(eventPath, "utf8"));
const pr = event.pull_request;
if (!pr) {
  console.error("This script only handles pull_request events.");
  process.exit(2);
}

const issueKey = extractIssueKey(pr.title, pr.head?.ref, pr.body);
if (!issueKey) {
  console.error(`PR must include a ${config.teamKey} issue key in the title, branch, or body.`);
  process.exit(1);
}

const issue = await getIssue(issueKey);
assertRepoIssue(issue);

const action = event.action;
const merged = action === "closed" && pr.merged;
const closedWithoutMerge = action === "closed" && !pr.merged;
const stateName = closedWithoutMerge
  ? null
  : merged
    ? config.workflowStates?.readyToDeploy
    : pr.draft
      ? config.workflowStates?.started
      : config.workflowStates?.review;

if (stateName) {
  await updateIssueState(issueKey, stateName);
}

const shouldComment = ["opened", "reopened", "ready_for_review", "converted_to_draft", "closed"].includes(action);
if (shouldComment) {
  const stateLabel = merged
    ? "merged; waiting on production deploy and smoke tests"
    : closedWithoutMerge
      ? "closed without merge"
    : pr.draft
      ? "draft"
      : "ready for review";
  await createIssueComment(
    issueKey,
    `GitHub PR ${stateLabel}: ${pr.html_url}\n\nBranch: \`${pr.head?.ref ?? "unknown"}\`\nCommit: \`${pr.head?.sha?.slice(0, 12) ?? "unknown"}\``,
  );
}

console.log(`${issueKey} synced${stateName ? ` to ${stateName}` : ""}`);
