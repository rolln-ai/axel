#!/usr/bin/env node
// ---------------------------------------------------------------------------
// release-verify.mjs — Axel deterministic release verification + error ledger.
//
// Runs the real per-workspace suite (typecheck / test / build), the root
// `biome check`, `pnpm audit`, the in-process e2e golden path, and (optionally)
// the deployed-env smoke checks. Captures every error verbatim and writes a
// per-version ledger under releases/<version>.json plus a cross-version
// releases/index.json and releases/CHANGELOG.md.
//
// Why per-workspace via `pnpm --filter` instead of `turbo run`: turbo.json gives
// test/typecheck/lint empty `outputs`, so turbo caches their exit status and
// replays "FULL TURBO" — which can hide a real regression. Filtered invocation
// is cache-immune and attributable per package.
//
// The deterministic side OWNS: checks/external/summary/status/git/runner/
// timestamp/version/tag. The AI audit (.claude/workflows/verify-axel-release.js)
// owns the `aiAudit` key only — `--merge-ai` and re-runs both preserve it.
//
// Usage:
//   node scripts/release-verify.mjs [--version x.y.z | --bump patch|minor|major]
//        [--skip-build] [--no-audit] [--smoke] [--smoke-required]
//        [--json-only] [--dry-run] [--out releases] [--notes "..."]
//   node scripts/release-verify.mjs --merge-ai <ai-audit.json> [--version x.y.z]
//
// Exit codes: 0 green · 1 red (ledger still written) · 2 usage/precondition
//             · 3 internal runner error.
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER = /^\d+\.\d+\.\d+$/;
const REQUIRED_KINDS = new Set(["typecheck", "test", "build", "lint", "audit", "e2e"]);
const ERR_USAGE = 2;
const ERR_INTERNAL = 3;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
let values;
try {
  ({ values } = parseArgs({
    options: {
      version: { type: "string" },
      bump: { type: "string" },
      "skip-build": { type: "boolean" },
      "no-audit": { type: "boolean" },
      smoke: { type: "boolean" },
      "smoke-required": { type: "boolean" },
      "json-only": { type: "boolean" },
      "dry-run": { type: "boolean" },
      "merge-ai": { type: "string" },
      notes: { type: "string" },
      out: { type: "string" },
      help: { type: "boolean" },
    },
    allowPositionals: false,
  }));
} catch (err) {
  fail(ERR_USAGE, `bad arguments: ${err.message}`);
}

if (values.help) {
  process.stdout.write(
    "release-verify.mjs — run the Axel release suite and write releases/<version>.json\n" +
      "  --version x.y.z         verify this version (strips a leading v)\n" +
      "  --bump patch|minor|major  bump VERSION, then verify the new value\n" +
      "  --skip-build            skip app builds (libraries still build for ^build)\n" +
      "  --no-audit              skip pnpm audit\n" +
      "  --smoke[ --smoke-required]  also run scripts/smoke.sh (gating only if required)\n" +
      "  --json-only             print only the ledger JSON\n" +
      "  --dry-run               print the check matrix and exit\n" +
      "  --merge-ai <file>       merge an AI-audit JSON under aiAudit (clobber-safe)\n" +
      "  --notes \"...\"          release note for the changelog\n" +
      "  --out <dir>             ledger dir (default releases)\n",
  );
  process.exit(0);
}

const OUT_DIR = join(REPO_ROOT, values.out || "releases");
const log = values["json-only"] ? () => {} : (m) => process.stdout.write(`${m}\n`);

// ---------------------------------------------------------------------------
// Version resolution
// ---------------------------------------------------------------------------
const VERSION_FILE = join(REPO_ROOT, "VERSION");

function readVersionFile() {
  if (!existsSync(VERSION_FILE)) fail(ERR_USAGE, "no VERSION file at repo root");
  const v = readFileSync(VERSION_FILE, "utf8").trim();
  if (!SEMVER.test(v)) fail(ERR_USAGE, `VERSION file holds invalid semver: "${v}"`);
  return v;
}

function normalizeVersion(raw) {
  const v = raw.replace(/^v/, "").trim();
  if (!SEMVER.test(v)) fail(ERR_USAGE, `invalid version "${raw}" (expected x.y.z)`);
  return v;
}

function bumpVersion(cur, kind) {
  const [maj, min, pat] = cur.split(".").map(Number);
  if (kind === "major") return `${maj + 1}.0.0`;
  if (kind === "minor") return `${maj}.${min + 1}.0`;
  if (kind === "patch") return `${maj}.${min}.${pat + 1}`;
  fail(ERR_USAGE, `--bump expects patch|minor|major, got "${kind}"`);
}

function resolveVersion({ allowWrite }) {
  if (values.version) return normalizeVersion(values.version);
  if (values.bump) {
    const next = bumpVersion(readVersionFile(), values.bump);
    if (allowWrite) {
      writeFileSync(VERSION_FILE, `${next}\n`);
      log(`bumped VERSION → ${next}`);
    }
    return next;
  }
  return readVersionFile();
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------
function exec(cmd, args, opts = {}) {
  const started = Date.now();
  const res = spawnSync(cmd, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: opts.timeout ?? 600_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, FORCE_COLOR: "0", CI: "1", TURBO_TELEMETRY_DISABLED: "1" },
  });
  return { res, durationMs: Date.now() - started };
}

function excerpt(res) {
  const parts = [];
  if (res.error) parts.push(`runner error: ${res.error.message}`);
  if (res.signal) parts.push(`terminated by signal ${res.signal}`);
  if (res.stdout) parts.push(res.stdout);
  if (res.stderr) parts.push(res.stderr);
  let text = parts.join("\n").trim();
  if (!text) return null;
  const CAP = 4000;
  if (text.length > CAP) text = `…(head truncated)…\n${text.slice(-CAP)}`;
  return text;
}

// A script is a no-op stub when its ENTIRE command is an echo/true/exit-0 with
// no real work chained after it (so a passing stub isn't counted as coverage).
function isStub(cmd) {
  if (!cmd) return true;
  const c = cmd.trim();
  if (c === "true" || c === ":" || c === "exit 0") return true;
  const head = c.replace(/\s*&&\s*exit\s+0\s*$/, "").trim();
  return /^echo(\s|$)/.test(head) && !/&&|\|\||;/.test(head);
}

// ---------------------------------------------------------------------------
// Workspace discovery
// ---------------------------------------------------------------------------
function workspaceGlobRoots() {
  const file = join(REPO_ROOT, "pnpm-workspace.yaml");
  if (!existsSync(file)) return ["apps", "packages"];
  const roots = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*-\s*["']?([^"'*]+)\/\*["']?\s*$/);
    if (m) roots.push(m[1].replace(/\/$/, ""));
  }
  return roots.length ? roots : ["apps", "packages"];
}

function discoverWorkspaces() {
  const out = [];
  for (const root of workspaceGlobRoots()) {
    const baseDir = join(REPO_ROOT, root);
    if (!existsSync(baseDir)) continue;
    for (const name of readdirSync(baseDir).sort()) {
      const pkgPath = join(baseDir, name, "package.json");
      if (!existsSync(pkgPath)) continue;
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        out.push({
          dir: `${root}/${name}`,
          isLib: root === "packages",
          name: pkg.name || `${root}/${name}`,
          scripts: pkg.scripts || {},
        });
      } catch (err) {
        fail(ERR_INTERNAL, `cannot parse ${pkgPath}: ${err.message}`);
      }
    }
  }
  if (!out.length) fail(ERR_USAGE, "discovered no workspaces");
  return out;
}

// ---------------------------------------------------------------------------
// Git / runner context
// ---------------------------------------------------------------------------
function git(args) {
  const r = spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

function runnerContext() {
  let pkg = {};
  try {
    pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  } catch {
    pkg = {};
  }
  const dep = (n) => (pkg.devDependencies?.[n] || pkg.dependencies?.[n] || "").replace(/^[\^~]/, "");
  return {
    node: process.versions.node,
    pnpm: (pkg.packageManager || "").replace(/^pnpm@/, "") || null,
    turbo: dep("turbo") || null,
    biome: dep("@biomejs/biome") || null,
    host: process.env.CI ? "ci" : "local",
  };
}

// ---------------------------------------------------------------------------
// Check matrix
// ---------------------------------------------------------------------------
function makeCheck(name, workspace, kind, command) {
  return {
    name,
    workspace,
    kind,
    command,
    status: "pass",
    real: true,
    durationMs: 0,
    errorExcerpt: null,
  };
}

function runWorkspaceScript(ws, kind, opts = {}) {
  const cmd = ws.scripts[kind];
  const check = makeCheck(`${ws.name}:${kind}`, ws.name, kind, `pnpm --filter ${ws.name} run ${kind}`);
  if (cmd === undefined) {
    check.status = "skipped";
    check.real = false;
    check.command = "(no script)";
    return check;
  }
  if (isStub(cmd)) {
    check.status = "stub";
    check.real = false;
    check.command = cmd;
    return check;
  }
  if (opts.skip) {
    check.status = "skipped";
    check.real = false;
    return check;
  }
  log(`  → ${check.name}`);
  const { res, durationMs } = exec("pnpm", ["--filter", ws.name, "run", kind], { timeout: opts.timeout });
  check.durationMs = durationMs;
  check.status = res.status === 0 ? "pass" : "fail";
  if (check.status === "fail") check.errorExcerpt = excerpt(res);
  return check;
}

function runAudit() {
  const check = makeCheck("root:audit", "(root)", "audit", "pnpm audit --audit-level high --json");
  log(`  → ${check.name}`);
  const { res, durationMs } = exec("pnpm", ["audit", "--audit-level", "high", "--json"]);
  check.durationMs = durationMs;
  if (res.status === 0) return check;
  try {
    const vulns = JSON.parse(res.stdout || "{}").metadata?.vulnerabilities || {};
    const high = (vulns.high || 0) + (vulns.critical || 0);
    if (high > 0) {
      check.status = "fail";
      check.errorExcerpt = `${high} high/critical advisories: ${JSON.stringify(vulns)}`;
    }
    // non-zero exit but no high/critical (e.g. only moderate) → still a pass at this level
  } catch {
    check.status = "fail";
    check.transient = true;
    check.errorExcerpt = `pnpm audit failed to produce parseable JSON (likely registry/network):\n${excerpt(res)}`;
  }
  return check;
}

function runLint() {
  const check = makeCheck("root:lint", "(root)", "lint", "pnpm exec biome check .");
  log(`  → ${check.name}`);
  const { res, durationMs } = exec("pnpm", ["exec", "biome", "check", "."]);
  check.durationMs = durationMs;
  check.status = res.status === 0 ? "pass" : "fail";
  if (check.status === "fail") check.errorExcerpt = excerpt(res);
  return check;
}

function runDeployScriptsTest() {
  // Root `pnpm test` runs this suite in CI; the release gate must match it,
  // otherwise the deploy-script tests gate PRs but not releases.
  const check = makeCheck("root:test:deploy-scripts", "(root)", "test", "pnpm test:deploy-scripts");
  log(`  → ${check.name}`);
  const { res, durationMs } = exec("pnpm", ["test:deploy-scripts"], { timeout: 300_000 });
  check.durationMs = durationMs;
  check.status = res.status === 0 ? "pass" : "fail";
  if (check.status === "fail") check.errorExcerpt = excerpt(res);
  return check;
}

function runSmoke() {
  const check = makeCheck("smoke", "(deployed)", "smoke", "bash scripts/smoke.sh");
  if (!values.smoke) {
    check.status = "skipped";
    check.real = false;
    return check;
  }
  log(`  → ${check.name}`);
  const { res, durationMs } = exec("bash", ["scripts/smoke.sh"], { timeout: 120_000 });
  check.durationMs = durationMs;
  check.status = res.status === 0 ? "pass" : "fail";
  if (check.status === "fail") check.errorExcerpt = excerpt(res);
  return check;
}

// ---------------------------------------------------------------------------
// Ledger writers
// ---------------------------------------------------------------------------
function loadJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function semverDesc(a, b) {
  const pa = a.version.split(".").map(Number);
  const pb = b.version.split(".").map(Number);
  return pb[0] - pa[0] || pb[1] - pa[1] || pb[2] - pa[2];
}

function writeLedger(ledger) {
  mkdirSync(OUT_DIR, { recursive: true });
  const file = join(OUT_DIR, `${ledger.version}.json`);
  const prev = loadJson(file, null);
  if (prev?.aiAudit) ledger.aiAudit = prev.aiAudit; // never clobber a prior AI audit
  writeFileSync(file, `${JSON.stringify(ledger, null, 2)}\n`);
  updateIndex(ledger);
  updateChangelog(ledger);
  return file;
}

function updateIndex(ledger) {
  const file = join(OUT_DIR, "index.json");
  const idx = loadJson(file, { schemaVersion: 1, latest: null, updatedAt: null, releases: [] });
  idx.releases = (idx.releases || []).filter((r) => r.version !== ledger.version);
  idx.releases.push({
    version: ledger.version,
    tag: ledger.tag,
    date: ledger.timestamp,
    sha: ledger.git.shortSha,
    status: ledger.status,
    errorCount: ledger.summary.fail,
    stubCount: ledger.summary.stub,
    aiAuditStatus: ledger.aiAudit?.overallVerdict ?? null,
  });
  idx.releases.sort(semverDesc);
  idx.latest = idx.releases[0]?.version ?? null;
  idx.updatedAt = ledger.timestamp;
  writeFileSync(file, `${JSON.stringify(idx, null, 2)}\n`);
}

function updateChangelog(ledger) {
  const file = join(OUT_DIR, "CHANGELOG.md");
  const TITLE =
    "# Axel release ledger\n\nPer-version verification results, written by `scripts/release-verify.mjs`.\n";
  const s = ledger.summary;
  const lines = [
    `## v${ledger.version} — ${ledger.timestamp.slice(0, 10)} (${ledger.status})`,
    "",
    `- ${s.pass} real checks passed, ${s.fail} failed, ${s.stub} stubs skipped, ${s.skipped} skipped.`,
    `- git ${ledger.git.shortSha} @ ${ledger.git.branch}${ledger.git.dirty ? " (dirty)" : ""}`,
  ];
  if (ledger.notes) lines.push(`- Notes: ${ledger.notes}`);
  const fails = ledger.checks.filter((c) => c.status === "fail");
  if (fails.length) {
    lines.push("", "### Failures");
    for (const c of fails) {
      const first = (c.errorExcerpt || "").split("\n").find((l) => l.trim()) || "(no output)";
      lines.push(`- \`${c.name}\` — ${first.slice(0, 160)}`);
    }
  }
  const section = `${lines.join("\n")}\n`;

  let body = "";
  if (existsSync(file)) {
    const raw = readFileSync(file, "utf8");
    const cut = raw.indexOf("\n## ");
    body = cut === -1 ? "" : raw.slice(cut + 1);
  }
  const sections = body ? body.split(/(?=^## )/m).filter((x) => x.trim()) : [];
  const kept = sections.filter((x) => !x.startsWith(`## v${ledger.version} `));
  const next = `${TITLE}\n${section}\n${kept.join("").trim()}\n`.replace(/\n{3,}/g, "\n\n");
  writeFileSync(file, next);
}

// ---------------------------------------------------------------------------
// --merge-ai mode
// ---------------------------------------------------------------------------
function mergeAi() {
  const version = resolveVersion({ allowWrite: false });
  const file = join(OUT_DIR, `${version}.json`);
  if (!existsSync(file)) {
    fail(ERR_USAGE, `no ledger at ${file} — run the deterministic verify for ${version} first`);
  }
  const ledger = loadJson(file, null);
  if (!ledger) fail(ERR_INTERNAL, `cannot parse existing ledger ${file}`);
  const payload = loadJson(values["merge-ai"], null);
  if (!payload) fail(ERR_USAGE, `cannot read AI-audit JSON at ${values["merge-ai"]}`);
  ledger.aiAudit = payload.aiAudit ?? payload; // accept the workflow return or a bare aiAudit object
  writeFileSync(file, `${JSON.stringify(ledger, null, 2)}\n`);
  updateIndex(ledger);
  log(`merged aiAudit (${ledger.aiAudit.overallVerdict ?? "?"}) into ${file}`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function fail(code, msg) {
  process.stderr.write(`release-verify: ${msg}\n`);
  process.exit(code);
}

function buildSummary(checks) {
  const byKind = {};
  const sum = { total: checks.length, pass: 0, fail: 0, skipped: 0, stub: 0, real: 0 };
  for (const c of checks) {
    sum[c.status] = (sum[c.status] || 0) + 1;
    if (c.real) sum.real += 1;
    byKind[c.kind] = byKind[c.kind] || { pass: 0, fail: 0, skipped: 0, stub: 0 };
    byKind[c.kind][c.status] = (byKind[c.kind][c.status] || 0) + 1;
  }
  sum.byKind = byKind;
  return sum;
}

function main() {
  if (values["merge-ai"]) return mergeAi();

  if (!existsSync(join(REPO_ROOT, "node_modules"))) {
    fail(ERR_USAGE, "node_modules missing — run `pnpm install --frozen-lockfile` first");
  }

  const version = resolveVersion({ allowWrite: true });
  const skipBuild = Boolean(values["skip-build"]);
  const workspaces = discoverWorkspaces();

  // --dry-run: print the planned matrix (with stub classification) and stop.
  if (values["dry-run"]) {
    log(`Release verify plan for v${version}:`);
    for (const ws of workspaces) {
      for (const kind of ["typecheck", "test", "build"]) {
        const cmd = ws.scripts[kind];
        const cls = cmd === undefined ? "absent" : isStub(cmd) ? "stub" : "real";
        log(`  ${ws.name.padEnd(26)} ${kind.padEnd(10)} ${cls}`);
      }
    }
    log("  (root)                     test       real (pnpm test:deploy-scripts)");
    log("  (root)                     lint       real (biome check .)");
    log(`  (root)                     audit      ${values["no-audit"] ? "skipped" : "real"}`);
    log("  @axel/e2e                  e2e        real");
    log(`  (deployed)                 smoke      ${values.smoke ? "real" : "skipped"}`);
    process.exit(0);
  }

  const checks = [];
  const E2E_WS = "@axel/e2e";

  // 1. Build first so library dist exists for downstream typecheck/test (^build).
  //    --skip-build still builds libraries; only app builds are skipped.
  log("Build:");
  for (const ws of workspaces) {
    checks.push(runWorkspaceScript(ws, "build", { skip: skipBuild && !ws.isLib, timeout: 600_000 }));
  }
  // 2. Typecheck.
  log("Typecheck:");
  for (const ws of workspaces) {
    checks.push(runWorkspaceScript(ws, "typecheck", { timeout: 300_000 }));
  }
  // 3. Test (e2e workspace handled separately as kind=e2e).
  log("Test:");
  for (const ws of workspaces) {
    if (ws.name === E2E_WS) continue;
    checks.push(runWorkspaceScript(ws, "test", { timeout: 600_000 }));
  }
  checks.push(runDeployScriptsTest());
  // 4. End-to-end golden path (in-process; no secrets).
  log("E2E:");
  const e2eWs = workspaces.find((w) => w.name === E2E_WS);
  if (e2eWs) {
    const c = runWorkspaceScript(e2eWs, "test", { timeout: 300_000 });
    c.name = `${E2E_WS}:e2e`;
    c.kind = "e2e";
    checks.push(c);
  }
  // 5. Per-workspace lint scripts are stubs; record them honestly, run real root biome.
  log("Lint:");
  for (const ws of workspaces) {
    const c = runWorkspaceScript(ws, "lint", { skip: true });
    if (c.status === "skipped" && ws.scripts.lint && isStub(ws.scripts.lint)) {
      c.status = "stub";
      c.command = ws.scripts.lint;
    }
    checks.push(c);
  }
  checks.push(runLint());
  // 6. Audit.
  if (values["no-audit"]) {
    const c = makeCheck("root:audit", "(root)", "audit", "pnpm audit");
    c.status = "skipped";
    c.real = false;
    checks.push(c);
  } else {
    checks.push(runAudit());
  }
  // 7. Smoke (optional, best-effort).
  checks.push(runSmoke());

  const summary = buildSummary(checks);
  const smokeRequired = Boolean(values["smoke-required"]);
  const red = checks.some(
    (c) =>
      c.status === "fail" &&
      (REQUIRED_KINDS.has(c.kind) || (c.kind === "smoke" && smokeRequired)),
  );

  const ledger = {
    schemaVersion: 1,
    product: "Axel",
    version,
    tag: `v${version}`,
    timestamp: new Date().toISOString(),
    notes: values.notes || null,
    git: {
      sha: git(["rev-parse", "HEAD"]),
      shortSha: git(["rev-parse", "--short", "HEAD"]),
      branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
      dirty: (git(["status", "--porcelain"]) || "").length > 0,
    },
    runner: { ...runnerContext(), flags: { skipBuild, smoke: Boolean(values.smoke), noAudit: Boolean(values["no-audit"]) } },
    checks,
    external: [
      {
        name: "codeql",
        kind: "lint",
        note: "Tracked in .github/workflows/codeql.yml; not executed by release-verify.",
      },
    ],
    summary,
    status: red ? "red" : "green",
    aiAudit: null,
  };

  let file;
  try {
    file = writeLedger(ledger);
  } catch (err) {
    fail(ERR_INTERNAL, `failed to write ledger: ${err.message}`);
  }

  if (values["json-only"]) {
    process.stdout.write(`${JSON.stringify(ledger, null, 2)}\n`);
  } else {
    log("");
    log(`Release ${ledger.tag} — ${ledger.status.toUpperCase()}`);
    log(
      `  ${summary.pass} pass · ${summary.fail} fail · ${summary.stub} stub · ${summary.skipped} skipped (of ${summary.total})`,
    );
    for (const c of checks.filter((x) => x.status === "fail")) {
      const first = (c.errorExcerpt || "").split("\n").find((l) => l.trim()) || "";
      log(`  ✗ ${c.name}: ${first.slice(0, 120)}`);
    }
    log(`  ledger → ${file.replace(`${REPO_ROOT}/`, "")}`);
  }

  process.exit(ledger.status === "red" ? 1 : 0);
}

main();
