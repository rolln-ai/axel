#!/usr/bin/env node
import { createIssueComment } from "./linear-api.mjs";

const issueKey = (process.argv[2] || "").toUpperCase();
const body = process.argv.slice(3).join(" ").trim();

if (!/^ROL-\d+$/.test(issueKey) || !body) {
  console.error('Usage: pnpm linear:comment ROL-123 "Message to post"');
  process.exit(1);
}

const comment = await createIssueComment(issueKey, body);
console.log(comment.url ?? `Commented on ${issueKey}`);
