import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * On-disk CLI config. Written to `~/.axel/config.json` so it survives
 * across shells. Mode 0600 because it carries an unhashed PAT.
 */
export interface CliConfig {
  token: string;
  api_base: string;
  workspace_id: string;
  workspace_name: string;
  token_name: string;
  minted_at: string;
}

const CONFIG_DIR = join(homedir(), ".axel");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export async function readConfig(): Promise<CliConfig | null> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<CliConfig>;
    if (
      typeof parsed.token !== "string"
      || typeof parsed.api_base !== "string"
      || typeof parsed.workspace_id !== "string"
    ) {
      return null;
    }
    return {
      token: parsed.token,
      api_base: parsed.api_base,
      workspace_id: parsed.workspace_id,
      workspace_name: parsed.workspace_name ?? "(unknown)",
      token_name: parsed.token_name ?? "(unknown)",
      minted_at: parsed.minted_at ?? new Date(0).toISOString(),
    };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function writeConfig(config: CliConfig): Promise<void> {
  await mkdir(dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

export async function clearConfig(): Promise<void> {
  try {
    await rm(CONFIG_PATH);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export function configPath(): string {
  return CONFIG_PATH;
}
