import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { drainImpactOutbox, recordImpactObservations } from "../lib/impact-alerts";
import { sourceSilenceObservation, type ImpactObservation } from "../lib/impact-alert-policy";
import type { SendArgs } from "../lib/email";

// Always synthetic, loopback-only. No production environment is consumed.
const integration = process.env.AXEL_RUN_POSTGRES_INTEGRATION === "1";
describe.skipIf(!integration)("incident transactions and recipient retries on Postgres", () => {
  let container: string;
  let pool: pg.Pool;
  const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
  beforeAll(async () => {
    container = docker("run", "--detach", "--rm", "--publish", "127.0.0.1::5432", "--env", "POSTGRES_PASSWORD=synthetic-only", "postgres:17-alpine");
    const port = docker("port", container, "5432/tcp").split(":").at(-1);
    pool = new pg.Pool({ connectionString: `postgresql://postgres:synthetic-only@127.0.0.1:${port}/postgres`, max: 6 });
    for (let i = 0; ; i++) {
      try { await pool.query("SELECT 1"); break; } catch { if (i > 80) throw new Error("disposable database unavailable"); await new Promise(r => setTimeout(r, 250)); }
    }
    await pool.query(readFileSync(new URL("../../../infra/postgres/schema.sql", import.meta.url), "utf8"));
    await pool.query(`CREATE ROLE synthetic_dashboard; CREATE ROLE synthetic_reader;
      GRANT SELECT, INSERT, UPDATE ON notification_preferences TO synthetic_dashboard;
      GRANT SELECT ON notification_preferences TO synthetic_reader;`);
    await pool.query(readFileSync(new URL("../../../infra/postgres/migrations/0076_impact_alerts.sql", import.meta.url), "utf8"));
    for (const table of ["pipeline_incidents", "alert_email_outbox"]) {
      const permissions = (await pool.query(`SELECT has_table_privilege('synthetic_dashboard', $1, 'SELECT,INSERT,UPDATE,DELETE') AS dashboard,
        has_table_privilege('synthetic_reader', $1, 'SELECT') AS reader`, [table])).rows[0];
      expect(permissions).toEqual({dashboard: true, reader: false});
    }
    await pool.query(`INSERT INTO workspaces (id, name) VALUES ('ws_a','Synthetic A'), ('ws_b','Synthetic B');
      INSERT INTO users (id,email,name,password_hash) VALUES ('u_a','a@example.invalid','A','synthetic'), ('u_b','b@example.invalid','B','synthetic');
      INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ('ws_a','u_a','owner'),('ws_a','u_b','admin');
      INSERT INTO sources (id,workspace_id,name,secret_token_hash,status) VALUES ('src_a','ws_a','Orders','synthetic','active');`);
  }, 60_000);
  afterAll(async () => { await pool?.end(); if (container) docker("rm", "--force", container); });
  const observation = (): ImpactObservation => sourceSilenceObservation({ id: "src_a", name: "Orders", created_at: "2020-01-01", alert_after_minutes: 30, flow_monitoring_enabled: true }, undefined, Date.now())!;
  const record = async (o: ImpactObservation[], date = new Date()) => {
    const c = await pool.connect();
    try { await c.query("BEGIN"); const result = await recordImpactObservations(c, "ws_a", o, date); await c.query("COMMIT"); return result; }
    catch (err) { await c.query("ROLLBACK"); throw err; } finally { c.release(); }
  };

  it("deduplicates concurrent scans, retries only failed recipients, and holds ambiguous sends", async () => {
    await Promise.all([record([observation()]), record([observation()])]);
    expect((await pool.query("SELECT * FROM pipeline_incidents")).rowCount).toBe(1);
    expect((await pool.query("SELECT * FROM alert_email_outbox")).rowCount).toBe(2);
    const calls: { args: SendArgs; key?: string }[] = [];
    const first = await drainImpactOutbox(pool, async (args, options) => {
      calls.push({ args, key: options?.idempotencyKey });
      return args.to.startsWith("a@") ? { ok: true, messageId: "provider-a" } : { ok: false };
    });
    expect(first).toMatchObject({ sent: 1, failed: 1 });
    expect((await pool.query("SELECT sent_at FROM alert_email_outbox WHERE state = 'pending'")).rows[0].sent_at).toBeNull();
    await pool.query("UPDATE alert_email_outbox SET next_attempt_at = now() WHERE state = 'pending'");
    const retry = await drainImpactOutbox(pool, async (args, options) => {
      expect(args).toEqual(calls.find(c => c.args.to.startsWith("b@"))!.args);
      expect(options?.idempotencyKey).toBe(calls.find(c => c.args.to.startsWith("b@"))!.key);
      return { ok: true, messageId: "provider-b" };
    });
    expect(retry.sent).toBe(1);
    expect((await pool.query("SELECT * FROM alert_email_outbox WHERE state = 'sent' AND payload = '{}'::jsonb")).rowCount).toBe(2);

    await pool.query("UPDATE pipeline_incidents SET next_reminder_at = now() - interval '1 hour', observed_at = now() - interval '1 minute'");
    await record([observation()]);
    await pool.query("UPDATE alert_email_outbox SET first_attempt_at = now() - interval '25 hours' WHERE state = 'pending'");
    const ambiguous = await drainImpactOutbox(pool, async () => { throw new Error("must not resend expired idempotency keys"); });
    expect(ambiguous.needs_review).toBe(2);
    expect(ambiguous.sent).toBe(0);
  });

  it("does not recover from absent telemetry, and requires healthy checks before recovery", async () => {
    await record([]);
    expect((await pool.query("SELECT * FROM pipeline_incidents WHERE resolved_at IS NULL")).rowCount).toBe(1);
    await pool.query("UPDATE pipeline_incidents SET observed_at = now() - interval '1 minute'");
    await record([{ ...observation(), unhealthy: false }]);
    expect((await pool.query("SELECT * FROM pipeline_incidents WHERE resolved_at IS NULL")).rowCount).toBe(1);
    await pool.query("UPDATE pipeline_incidents SET healthy_since = now() - interval '16 minutes', observed_at = now() - interval '1 minute'");
    await record([{ ...observation(), unhealthy: false }]);
    expect((await pool.query("SELECT * FROM pipeline_incidents WHERE resolved_at IS NOT NULL")).rowCount).toBe(1);
    expect((await pool.query("SELECT * FROM alert_email_outbox WHERE phase = 'recovered'")).rowCount).toBe(2);
  });

  it("cancels queued email after membership removal and scopes incident writes", async () => {
    await pool.query("DELETE FROM workspace_members WHERE workspace_id = 'ws_a' AND user_id = 'u_b'");
    const sent = await drainImpactOutbox(pool, async args => { expect(args.to).toBe("a@example.invalid"); return { ok: true, messageId: "recovery-a" }; });
    expect(sent.sent).toBe(1);
    expect((await pool.query("SELECT * FROM alert_email_outbox WHERE user_id = 'u_b' AND phase = 'recovered' AND state = 'cancelled'")).rowCount).toBe(1);
    expect((await pool.query("SELECT * FROM pipeline_incidents WHERE workspace_id = 'ws_b'")).rowCount).toBe(0);
  });
});
