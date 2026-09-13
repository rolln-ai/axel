#!/usr/bin/env bash
set -euo pipefail

image="${1:-axel-dashboard:ci}"
# Exercise the image's real non-root entrypoint with two unrelated hostnames.
# No services, credentials, database, or network access are needed.
for hostname in first.example.test changed.example.test; do
  docker run --rm --network none \
    --env AXEL_DEPLOYMENT_MODE=self-hosted \
    --env "AXEL_APP_URL=https://$hostname" \
    --env "AXEL_INGEST_URL=https://ingest.$hostname" \
    --env "AXEL_DELIVERY_URL=https://delivery.$hostname" \
    "$image" node --input-type=module -e '
      import assert from "node:assert/strict";
      import { readFileSync } from "node:fs";
      const spec = readFileSync("public/openapi.yaml", "utf8");
      assert.ok(spec.includes(process.env.AXEL_APP_URL));
      assert.ok(spec.includes(process.env.AXEL_INGEST_URL));
      assert.ok(!spec.includes("app.axelapp.ai"));
      assert.ok(!spec.includes("ingest.axelapp.ai"));
      assert.ok(!spec.includes("ingest.example.invalid"));
      assert.notEqual(process.getuid(), 0);
      console.log("Runtime origins rendered as the unprivileged container user.");
    '
done
if docker run --rm --network none \
  --env AXEL_DEPLOYMENT_MODE=self-hosted "$image" true >/dev/null 2>&1; then
  echo "self-host dashboard started without runtime origins" >&2
  exit 1
fi
