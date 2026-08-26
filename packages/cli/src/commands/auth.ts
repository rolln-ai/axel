import { createInterface } from "node:readline/promises";
import { CliApiError, makeClient, normalizeApiBaseUrl } from "../api-client.js";
import { clearConfig, configPath, readConfig, writeConfig } from "../config.js";

const DEFAULT_API_BASE = "https://app.axelapp.ai";

interface MeResponse {
  user: { id: string; email: string };
  workspace: { id: string; name: string };
  token: { id: string; name: string; created_at: string };
}

export async function authLogin(flags: Record<string, string>): Promise<void> {
  let apiBase: string;
  try {
    apiBase = normalizeApiBaseUrl(flags["api-base"] ?? DEFAULT_API_BASE);
  } catch (err: unknown) {
    console.error(`Invalid API base: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 64;
    return;
  }
  const token = flags.token ?? (await promptForToken());
  if (!token) {
    console.error("No token provided. Run `axel auth login --token <pat>` or paste at the prompt.");
    process.exitCode = 64;
    return;
  }
  const probe = makeClient({
    token,
    api_base: apiBase,
    workspace_id: "",
    workspace_name: "",
    token_name: "",
    minted_at: "",
  });
  let me: MeResponse;
  try {
    me = await probe.get<MeResponse>("/v1/cli/me");
  } catch (err: unknown) {
    if (err instanceof CliApiError) {
      console.error(`Login failed (${err.status} ${err.code}): ${err.message}`);
    } else {
      console.error(`Login failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exitCode = 1;
    return;
  }

  await writeConfig({
    token,
    api_base: apiBase,
    workspace_id: me.workspace.id,
    workspace_name: me.workspace.name,
    token_name: me.token.name,
    minted_at: me.token.created_at,
  });
  console.log(`Signed in as ${me.user.email} → ${me.workspace.name} (${me.workspace.id}).`);
  console.log(`Token "${me.token.name}" saved to ${configPath()}.`);
}

export async function authStatus(): Promise<void> {
  const config = await readConfig();
  if (!config) {
    console.log("Not signed in. Run `axel auth login`.");
    process.exitCode = 1;
    return;
  }
  try {
    const me = await makeClient(config).get<MeResponse>("/v1/cli/me");
    console.log(`Signed in as ${me.user.email} → ${me.workspace.name} (${me.workspace.id}).`);
    console.log(`Token "${me.token.name}" minted ${me.token.created_at}.`);
    console.log(`API base: ${config.api_base}`);
    console.log(`Config:   ${configPath()}`);
  } catch (err: unknown) {
    if (err instanceof CliApiError && err.status === 401) {
      console.log("Token is no longer valid — run `axel auth login` to rotate it.");
      process.exitCode = 1;
      return;
    }
    console.error(`Status check failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

export async function authLogout(): Promise<void> {
  await clearConfig();
  console.log("Signed out.");
}

async function promptForToken(): Promise<string> {
  if (!process.stdin.isTTY) return "";
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("Paste your Axel personal access token: ");
    return answer.trim();
  } finally {
    rl.close();
  }
}
