#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const workflowDirectory = fileURLToPath(new URL("../.github/workflows/", import.meta.url));
const untrustedExpression = /\$\{\{\s*(?:inputs(?:\.|\[)|github\.(?:event(?:\.|\[)|head_ref\b|ref_name\b))/;
const failures = [];

for (const name of readdirSync(workflowDirectory).filter((entry) => /\.ya?ml$/.test(entry)).sort()) {
  const lines = readFileSync(`${workflowDirectory}/${name}`, "utf8").split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)run:\s*(.*)$/);
    if (!match) continue;

    const runIndent = match[1].length;
    const scalar = match[2];
    const candidates = [];

    if (scalar && !/^[|>][-+]?\s*(?:#.*)?$/.test(scalar)) {
      candidates.push({ line: index + 1, text: scalar });
    } else {
      for (let blockIndex = index + 1; blockIndex < lines.length; blockIndex += 1) {
        const blockLine = lines[blockIndex];
        if (blockLine.trim() && blockLine.match(/^\s*/)[0].length <= runIndent) break;
        candidates.push({ line: blockIndex + 1, text: blockLine });
      }
    }

    for (const candidate of candidates) {
      if (untrustedExpression.test(candidate.text)) {
        failures.push(`${name}:${candidate.line}: pass untrusted workflow data through env before using it in a shell`);
      }
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write("Workflow shell interpolation check passed.\n");
