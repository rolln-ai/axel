import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function policyList(source, key) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line === `${key}:`);
  assert.notEqual(start, -1, `${key} is present`);
  const values = [];
  for (const line of lines.slice(start + 1)) {
    const match = line.match(/^  - (.+)$/);
    if (!match) break;
    values.push(match[1].replace(/^['"]|['"]$/g, ""));
  }
  return values;
}

test("project manifests and distributions carry the Apache-2.0 license", () => {
  const manifests = execFileSync(
    "git",
    ["ls-files", "package.json", "apps/*/package.json", "packages/*/package.json"],
    { cwd: root, encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter(Boolean);

  assert.equal(manifests.length, 17, "all project package manifests are covered");
  for (const manifest of manifests) {
    const metadata = JSON.parse(readFileSync(path.join(root, manifest), "utf8"));
    assert.equal(metadata.license, "Apache-2.0", manifest);
  }

  const license = readFileSync(path.join(root, "LICENSE"), "utf8");
  const notice = readFileSync(path.join(root, "NOTICE"), "utf8");
  const openapi = readFileSync(path.join(root, "apps/dashboard/public/openapi.yaml"), "utf8");
  const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");

  assert.match(license, /Apache License\s+Version 2\.0, January 2004/u);
  assert.match(notice, /Copyright 2026 rolln, Inc\./u);
  assert.match(openapi, /identifier: Apache-2\.0/u);
  assert.match(dockerfile, /COPY LICENSE NOTICE THIRD_PARTY_NOTICES\.md \./u);
});

test("the locked dependency graph matches the reviewed license policy", () => {
  const nodeVersion = readFileSync(path.join(root, ".node-version"), "utf8").trim();
  const nodeVersionParts = nodeVersion.split(".").map(Number);
  assert.equal(nodeVersionParts.length, 3, "the CI Node pin is an exact version");
  assert.ok(
    nodeVersionParts.every(Number.isInteger),
    "the CI Node pin contains only numeric version components",
  );
  assert.ok(
    nodeVersionParts[0] === 22 && nodeVersionParts[1] >= 13,
    "the CI Node pin keeps the Linux license inventory installable",
  );

  const policySource = readFileSync(
    path.join(root, ".github/dependency-review-config.yml"),
    "utf8",
  );
  const allowedLicenses = new Set(policyList(policySource, "allow_licenses"));
  const packageExceptions = new Set(
    policyList(policySource, "allow_dependencies_licenses").map((purl) =>
      purl.replace(/^pkg:npm\//, ""),
    ),
  );
  const lockfileSource = readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8");
  const sentryHostPackages = new Set(
    Array.from(
      lockfileSource.matchAll(
        /^  '(@sentry\/cli-(?:darwin|linux|win32)[^@']*)@[^']+':$/gm,
      ),
      (match) => match[1],
    ),
  );
  assert.deepEqual(
    [...sentryHostPackages].filter((name) => !packageExceptions.has(name)).sort(),
    [],
    "all locked Sentry host helpers have reviewed license exceptions",
  );
  const inventory = JSON.parse(
    execFileSync("pnpm", ["licenses", "list", "--json"], {
      cwd: root,
      encoding: "utf8",
    }),
  );

  const unreviewed = [];
  for (const [license, packages] of Object.entries(inventory)) {
    if (allowedLicenses.has(license)) continue;
    for (const dependency of packages) {
      if (!packageExceptions.has(dependency.name)) {
        unreviewed.push(`${dependency.name}@${dependency.versions.join(",")}: ${license}`);
      }
    }
  }
  assert.deepEqual(unreviewed, []);
});
