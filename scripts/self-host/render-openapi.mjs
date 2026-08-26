import { readFile, writeFile } from "node:fs/promises";

const [path, appUrlInput, ingestUrlInput] = process.argv.slice(2);

if (!path || !appUrlInput || !ingestUrlInput) {
  throw new Error("usage: render-openapi.mjs <path> <app-url> <ingest-url>");
}

function normalizedHttpUrl(input, name) {
  const parsed = new URL(input);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} must use http:// or https://`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${name} must not contain embedded credentials`);
  }
  return input.replace(/\/+$/, "");
}

const appUrl = normalizedHttpUrl(appUrlInput, "app URL");
const ingestUrl = normalizedHttpUrl(ingestUrlInput, "ingest URL");
const template = await readFile(path, "utf8");
const rendered = template
  .replaceAll("https://app.axelapp.ai", appUrl)
  .replaceAll("https://ingest.axelapp.ai", ingestUrl);

await writeFile(path, rendered, "utf8");
