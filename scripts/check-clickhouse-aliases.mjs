#!/usr/bin/env node
/**
 * Guard against the ClickHouse self-alias shadowing footgun.
 *
 * ClickHouse resolves SELECT-list aliases GLOBALLY, not left-to-right, so a
 * stringified column aliased back to its own name shadows the underlying
 * typed column for the WHOLE statement:
 *
 *     SELECT toString(received_at) AS received_at        -- String alias
 *       FROM events
 *      WHERE received_at < parseDateTime64BestEffort(...) -- now String vs DateTime64 → error
 *
 * This has bitten prod twice:
 *   - 2026-05-15: dateDiff('day', received_at, now())  → "illegal type ... got String"
 *   - 2026-06-16: received_at < parseDateTime64BestEffort(...) → "No operation less between String and DateTime64(3)"
 *
 * The fix is always to alias to a distinct name (e.g. `received_at_text`).
 *
 * A blanket "never self-alias toString" rule is too noisy — most self-aliases
 * are harmless because the column is only SELECTed / ORDER BY'd, never
 * range-compared. So this check flags ONLY the dangerous co-occurrence:
 * a `toString(C) AS C` self-alias in the SAME SQL statement as a
 * type-sensitive use of bare `C` (a range comparison, BETWEEN, or a temporal
 * function argument).
 *
 * Run: `node scripts/check-clickhouse-aliases.mjs` (or `pnpm lint:sql`).
 *      `node scripts/check-clickhouse-aliases.mjs --self-test` to verify the detector.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

// Stringifying functions that change a typed column into a String.
const STRINGIFIERS = ["toString", "formatDateTime", "toJSONString"];
// Temporal functions that expect a real DateTime argument — passing the
// shadowed String alias here is the dateDiff-class failure.
const TEMPORAL_FUNCS = [
  "dateDiff",
  "date_diff",
  "age",
  "timestampDiff",
  "toRelativeSecondNum",
  "toRelativeMinuteNum",
  "toRelativeHourNum",
  "toRelativeDayNum",
];

/** Strip SQL comments so they can't trigger false positives. */
function stripSqlComments(sql) {
  return sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
}

/**
 * Given the text of a single SQL statement, return the list of column names
 * that are both (a) self-aliased through a stringifier and (b) used in a
 * type-sensitive position elsewhere in the same statement.
 */
export function findShadowingHazards(sql) {
  const clean = stripSqlComments(sql);
  const hazards = [];
  const selfAlias = new RegExp(
    `\\b(?:${STRINGIFIERS.join("|")})\\(\\s*([A-Za-z_]\\w*(?:\\.[A-Za-z_]\\w*)*)\\s*\\)\\s+AS\\s+([A-Za-z_]\\w*)\\b`,
    "gi",
  );
  while (true) {
    const m = selfAlias.exec(clean);
    if (m === null) break;
    const col = m[1].split(".").pop(); // bare column name that would shadow
    const alias = m[2];
    if (col !== alias) continue; // distinct alias → safe (this is the fix)

    const c = escapeRe(col);
    // Range comparison with the column on either side: `col < x`, `x >= col`, BETWEEN.
    const rangeCmp = new RegExp(`(?:\\b${c}\\b\\s*(?:<=|>=|<|>)|(?:<=|>=|<|>)\\s*\\b${c}\\b|\\b${c}\\b\\s+BETWEEN\\b)`, "i");
    // The column passed as an argument to a temporal function.
    const temporalArg = new RegExp(`\\b(?:${TEMPORAL_FUNCS.join("|")})\\s*\\([^)]*\\b${c}\\b[^)]*\\)`, "i");

    if (rangeCmp.test(clean) || temporalArg.test(clean)) {
      hazards.push({ col, index: m.index });
    }
  }
  return hazards;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Extract backtick template literals that look like SQL (SELECT … FROM …). */
function* sqlLiterals(src) {
  // Template literals don't contain raw backticks in this codebase, so a
  // non-greedy backtick match is sufficient and avoids matching // comments
  // and /regex/ literals.
  const re = /`([^`]*)`/g;
  while (true) {
    const m = re.exec(src);
    if (m === null) break;
    const body = m[1];
    if (/\bSELECT\b/i.test(body) && /\bFROM\b/i.test(body)) {
      yield { body, index: m.index + 1 }; // +1 to skip the opening backtick
    }
  }
}

function lineOf(src, offset) {
  return src.slice(0, offset).split("\n").length;
}

function runSelfTest() {
  const bad1 = "SELECT toString(received_at) AS received_at FROM events WHERE received_at < parseDateTime64BestEffort('x')";
  const bad2 = "SELECT event_id, dateDiff('day', received_at, now()) AS d, toString(received_at) AS received_at FROM events";
  const good1 = "SELECT toString(received_at) AS received_at_text FROM events WHERE received_at < now() ORDER BY received_at DESC";
  const good2 = "SELECT toString(received_at) AS received_at FROM events WHERE workspace_id = {w:String} ORDER BY received_at DESC";
  const cases = [
    ["bad: range compare", bad1, true],
    ["bad: temporal func", bad2, true],
    ["good: renamed alias", good1, false],
    ["good: self-alias but no type-sensitive use", good2, false],
  ];
  let ok = true;
  for (const [name, sql, expectHazard] of cases) {
    const got = findShadowingHazards(sql).length > 0;
    const pass = got === expectHazard;
    if (!pass) ok = false;
    console.log(`${pass ? "✓" : "✗"} ${name} (expected hazard=${expectHazard}, got=${got})`);
  }
  process.exit(ok ? 0 : 1);
}

function main() {
  if (process.argv.includes("--self-test")) return runSelfTest();

  const files = execSync(
    "git ls-files --cached --others --exclude-standard '*.ts' '*.tsx'",
    { encoding: "utf8" },
  )
    .split("\n")
    .filter((file) => Boolean(file) && existsSync(file));

  const findings = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    for (const { body, index } of sqlLiterals(src)) {
      for (const hz of findShadowingHazards(body)) {
        findings.push({ file, line: lineOf(src, index + hz.index), col: hz.col });
      }
    }
  }

  if (findings.length === 0) {
    console.log("✓ no ClickHouse self-alias shadowing hazards found");
    return;
  }

  console.error("✗ ClickHouse self-alias shadowing hazard(s) found:\n");
  for (const f of findings) {
    console.error(
      `  ${f.file}:${f.line}  toString(${f.col}) AS ${f.col} — the String alias shadows the typed column,\n` +
        `      which is also range-compared / used in a temporal function in the same query.\n` +
        `      Alias to a distinct name (e.g. ${f.col}_text) so the raw column stays bound.\n`,
    );
  }
  console.error(`${findings.length} hazard(s). See scripts/check-clickhouse-aliases.mjs for context.`);
  process.exit(1);
}

main();
