const FIVE_MINUTES = 5 * 60_000;

export function dueCronPaths(date) {
  const minute = date.getUTCMinutes();
  const hour = date.getUTCHours();
  const day = date.getUTCDay();
  const paths = [];
  if (minute % 5 === 0) paths.push("/api/cron/data-contracts-drift", "/api/cron/workspace-teardown");
  if (minute % 30 === 0) paths.push("/api/cron/data-contracts-auto-draft");
  if (minute % 15 === 0) paths.push("/api/cron/notification-scan");
  if (minute === 0) paths.push("/api/cron/billing-rollup");
  if (hour === 14 && minute === 0) paths.push("/api/cron/notifications-digest");
  if (day === 1 && hour === 15 && minute === 0) paths.push("/api/cron/nudges");
  return paths;
}

async function invoke(path, baseUrl, secret) {
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "GET",
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(4 * 60_000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.error(`[cron] ${path} returned ${response.status}: ${detail.slice(0, 200)}`);
    }
  } catch (error) {
    console.error(`[cron] ${path} failed:`, error instanceof Error ? error.message : error);
  }
}

export async function tick(date, options) {
  const stamp = date.toISOString().slice(0, 16);
  await Promise.all(
    dueCronPaths(date).map((path) => {
      const key = `${stamp}:${path}`;
      if (options.seen.has(key)) return Promise.resolve();
      options.seen.add(key);
      return invoke(path, options.baseUrl, options.secret);
    }),
  );
  for (const key of options.seen) {
    if (!key.startsWith(stamp)) options.seen.delete(key);
  }
}

async function main() {
  const baseUrl = (process.env.DASHBOARD_INTERNAL_URL ?? "http://dashboard:3000").replace(/\/$/, "");
  const secret = process.env.CRON_SECRET;
  if (!secret) throw new Error("CRON_SECRET is required");
  const options = { baseUrl, secret, seen: new Set() };
  await tick(new Date(), options);
  setInterval(() => void tick(new Date(), options), FIVE_MINUTES / 5);
  console.log(`[cron] scheduler started for ${baseUrl}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void main().catch((error) => {
    console.error("[cron] fatal:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
