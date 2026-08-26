/**
 * Coverage check: every /api/v1 route handler must be documented in
 * public/openapi.yaml, and every path in the spec under /api/v1 must
 * have a matching handler.
 *
 * If you add a new endpoint and forget to update the spec, this test
 * fails. If you delete an endpoint and forget to prune the spec, this
 * test also fails.
 *
 * The ingest endpoint (`/in/{sourceId}`) lives in apps/ingest-worker
 * and is intentionally NOT covered here — it's a Cloudflare Worker
 * outside the Next.js handler tree. Drift between ingest-worker and
 * the spec is rare (one POST handler), but if you change its surface
 * remember to update the spec by hand.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

type AnyObj = Record<string, unknown>;

const SPEC_PATH = resolve(__dirname, "..", "public", "openapi.yaml");
const SPEC = parseYaml(readFileSync(SPEC_PATH, "utf8")) as AnyObj;

const V1_ROOT = resolve(__dirname, "..", "app", "api", "v1");

const METHOD_EXPORTS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
type Method = (typeof METHOD_EXPORTS)[number];

interface RouteHandler {
  /** OpenAPI-style path, e.g. `/api/v1/sources` or `/api/v1/sources/{id}`. */
  path: string;
  method: Method;
}

/**
 * Walk the v1 route tree and discover every (method, path) pair
 * exported by a `route.ts` file. Next.js App Router conventions:
 *  - segment `[id]` → OpenAPI param `{id}`
 *  - route groups `(name)` are stripped from the URL
 */
function discoverHandlers(): RouteHandler[] {
  const found: RouteHandler[] = [];
  walk(V1_ROOT, (filePath) => {
    if (!filePath.endsWith("/route.ts") && !filePath.endsWith("/route.tsx")) return;
    const text = readFileSync(filePath, "utf8");
    const apiPath = filePathToApiPath(filePath);
    for (const method of METHOD_EXPORTS) {
      const re = new RegExp(`export\\s+(?:async\\s+)?function\\s+${method}\\b`);
      if (re.test(text)) {
        found.push({ method, path: apiPath });
      }
    }
  });
  return found;
}

function walk(root: string, visit: (filePath: string) => void): void {
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, visit);
    else visit(full);
  }
}

function filePathToApiPath(filePath: string): string {
  const rel = relative(resolve(__dirname, "..", "app"), filePath);
  // rel looks like: api/v1/sources/route.ts or api/v1/sources/[id]/route.ts
  const withoutRoute = rel.replace(/\/route\.(ts|tsx)$/, "");
  // Strip Next.js route groups: "(app)/..."
  const segments = withoutRoute
    .split("/")
    .filter((s) => !(s.startsWith("(") && s.endsWith(")")))
    .map((s) => s.replace(/^\[(\.{3})?(.+)\]$/, "{$2}"));
  return "/" + segments.join("/");
}

/**
 * Pull every (method, path) pair documented in the spec that starts
 * with `/api/v1`. The ingest endpoint is at a different prefix and
 * intentionally lives outside this check.
 */
function specOperations(): RouteHandler[] {
  const paths = SPEC.paths as AnyObj;
  const out: RouteHandler[] = [];
  for (const [path, pathItem] of Object.entries(paths)) {
    if (!path.startsWith("/api/v1")) continue;
    const item = pathItem as AnyObj;
    for (const method of METHOD_EXPORTS) {
      if (item[method.toLowerCase()]) out.push({ method, path });
    }
  }
  return out;
}

function key(r: RouteHandler): string {
  return `${r.method} ${r.path}`;
}

describe("OpenAPI coverage — handlers ↔ spec", () => {
  const handlers = discoverHandlers();
  const documented = specOperations();
  const handlerKeys = new Set(handlers.map(key));
  const specKeys = new Set(documented.map(key));

  it("discovers at least one handler (sanity)", () => {
    expect(handlers.length).toBeGreaterThan(0);
  });

  it("every route handler is documented in openapi.yaml", () => {
    const missing = handlers.filter((h) => !specKeys.has(key(h)));
    if (missing.length > 0) {
      throw new Error(
        `Undocumented handlers (add to public/openapi.yaml):\n  ` +
          missing.map(key).join("\n  "),
      );
    }
  });

  it("every documented /api/v1 operation has a handler", () => {
    const orphaned = documented.filter((d) => !handlerKeys.has(key(d)));
    if (orphaned.length > 0) {
      throw new Error(
        `Spec documents operations with no matching handler (remove from public/openapi.yaml or add the handler):\n  ` +
          orphaned.map(key).join("\n  "),
      );
    }
  });
});
