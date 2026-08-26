import { existsSync, readFileSync } from "node:fs";
import { loadLocalEnv } from "./load-env.mjs";

loadLocalEnv();

// linear.config.json is gitignored in the public repo (it holds the private
// workspace's IDs). Maintainers keep a local copy; CI injects it via the
// LINEAR_CONFIG_JSON repo variable. Without either, config is null and the
// Linear scripts no-op instead of crashing on a fresh clone.
function loadLinearConfig() {
  if (existsSync("linear.config.json")) {
    return JSON.parse(readFileSync("linear.config.json", "utf8"));
  }
  if (process.env.LINEAR_CONFIG_JSON) {
    return JSON.parse(process.env.LINEAR_CONFIG_JSON);
  }
  return null;
}

export const config = loadLinearConfig();
export const issueKeyPattern = config ? new RegExp(`\\b${config.issueKeyPattern}\\b`, "i") : null;

export function requireLinearApiKey() {
  if (!process.env.LINEAR_API_KEY) {
    console.error("Set LINEAR_API_KEY in .env.local or the shell. Do not commit it.");
    process.exit(1);
  }
}

// "Linear PR sync" is a REQUIRED check, so a blip in someone else's API
// shouldn't red-line a PR. These are the failures worth another attempt:
// gateway/rate-limit statuses, socket-level errors, and — the one that
// actually bit us — a proxy error page served instead of JSON, which used to
// crash the script on JSON.parse with an unreadable SyntaxError.
const MAX_ATTEMPTS = 4;
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRY_BASE_DELAY_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function linear(query, variables = {}) {
  requireLinearApiKey();

  for (let attempt = 1; ; attempt++) {
    let retryable = false;
    try {
      const res = await fetch("https://api.linear.app/graphql", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: process.env.LINEAR_API_KEY,
        },
        body: JSON.stringify({ query, variables }),
      });

      const body = await res.text();
      let json = null;
      try {
        json = JSON.parse(body);
      } catch {
        json = null;
      }

      if (json === null) {
        // Never a legitimate GraphQL response — an edge/proxy error page.
        retryable = true;
        throw new Error(
          `Linear API returned HTTP ${res.status} with a non-JSON body: ${body.trim().slice(0, 200)}`,
        );
      }
      if (!res.ok && RETRY_STATUS.has(res.status)) {
        retryable = true;
        throw new Error(`Linear API returned HTTP ${res.status}: ${body.trim().slice(0, 200)}`);
      }
      // GraphQL-level errors are the API answering us — a real problem with
      // the query or the data, so surface them without retrying.
      if (json.errors) throw new Error(JSON.stringify(json.errors, null, 2));
      return json.data;
    } catch (error) {
      // fetch() throws TypeError for DNS/TLS/socket failures — also transient.
      if (error instanceof TypeError) retryable = true;
      if (!retryable || attempt >= MAX_ATTEMPTS) throw error;
      console.warn(
        `Linear API attempt ${attempt}/${MAX_ATTEMPTS} failed, retrying: ${error.message}`,
      );
      await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }
}

export function extractIssueKey(...values) {
  if (!issueKeyPattern) return null;
  for (const value of values) {
    const match = String(value ?? "").match(issueKeyPattern);
    if (match) return match[0].toUpperCase();
  }
  return null;
}

export function issueNumber(issueOrKey) {
  const key = typeof issueOrKey === "string" ? issueOrKey : issueOrKey.identifier;
  return Number(key.split("-")[1] ?? "999999");
}

export function labels(issue) {
  return new Set((issue.labels?.nodes ?? []).map((label) => label.name));
}

export function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 56);
}

export async function getIssue(issueKey) {
  const data = await linear(
    `query Issue($key: String!) {
      issue(id: $key) {
        id
        identifier
        title
        url
        description
        priority
        state { id name type }
        project { id name url }
        projectMilestone { name }
        labels { nodes { name } }
      }
    }`,
    { key: issueKey },
  );
  return data.issue;
}

export async function getTeamStates() {
  const data = await linear(
    `query Team($id: String!) {
      team(id: $id) {
        states { nodes { id name type position } }
      }
    }`,
    { id: config.teamId },
  );
  return data.team.states.nodes;
}

export async function updateIssueState(issueKey, stateName) {
  if (!stateName) return null;

  const issue = await getIssue(issueKey);
  if (!issue) throw new Error(`No Linear issue found for ${issueKey}`);
  if (issue.state?.name === stateName) return issue.state;

  const state = (await getTeamStates()).find((candidate) => candidate.name === stateName);
  if (!state) throw new Error(`No Linear state named "${stateName}"`);

  await linear(
    `mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success }
    }`,
    { id: issue.id, input: { stateId: state.id } },
  );
  return state;
}

export async function createIssueComment(issueKey, body) {
  const issue = await getIssue(issueKey);
  if (!issue) throw new Error(`No Linear issue found for ${issueKey}`);

  const result = await linear(
    `mutation Comment($input: CommentCreateInput!) {
      commentCreate(input: $input) {
        success
        comment { id url }
      }
    }`,
    { input: { issueId: issue.id, body } },
  );
  return result.commentCreate.comment;
}

export function isRepoIssue(issue) {
  return labels(issue).has(config.primaryRepoLabel);
}

export function assertRepoIssue(issue) {
  if (!issue) throw new Error("Linear issue not found");
  if (issue.project?.id !== config.projectId) {
    throw new Error(`${issue.identifier} is not in ${config.projectName}`);
  }
  if (!isRepoIssue(issue)) {
    throw new Error(`${issue.identifier} is missing label ${config.primaryRepoLabel}`);
  }
}

export function currentIssueKeyFromFile() {
  if (!existsSync(".linear/current-issue.md")) return null;
  return extractIssueKey(readFileSync(".linear/current-issue.md", "utf8"));
}
