import type { CSSProperties } from "react";
import { Logo } from "./Logo";

/* ----------------------------------------------------------------- */
/* Mocked workspace data shared by the product screenshots            */
/* ----------------------------------------------------------------- */

const kpis = [
  { label: "Events ingested", value: "1.24M", delta: 32, tone: "pos" as const },
  { label: "Deliveries", value: "2.41M", delta: 28, tone: "pos" as const },
  { label: "Success rate", value: "99.997%", delta: 0.08, tone: "pos" as const, suffix: "pts" },
  { label: "Unresolved", value: "11", delta: -42, tone: "pos" as const, inverse: true },
  { label: "Active sources", value: "12", sub: "4 routes" },
];

// 14-day series: events (orange) and deliveries (success/failure stacked)
const eventBars = [54, 68, 72, 58, 81, 64, 76, 88, 71, 92, 84, 78, 96, 100];
const successBars = [49, 62, 65, 53, 73, 58, 70, 82, 67, 86, 79, 73, 90, 94];
const failureBars = [3, 4, 5, 3, 4, 4, 4, 5, 4, 5, 4, 4, 4, 5];
const axisDates = ["6/3", "6/4", "6/5", "6/6", "6/7", "6/8", "6/9", "6/10", "6/11", "6/12", "6/13", "6/14", "6/15", "6/16"];

const topSources = [
  { name: "stripe.webhooks", id: "src_01HZ4K…", events: "612,403", pct: 100 },
  { name: "github.webhooks", id: "src_01HZX2…", events: "318,772", pct: 52 },
  { name: "shopify.webhooks", id: "src_01J0AB…", events: "164,210", pct: 27 },
  { name: "partner.webhook", id: "src_01J1PK…", events: "92,481", pct: 15 },
  { name: "internal.webhook", id: "src_01J2D9…", events: "44,108", pct: 7 },
];

const activity = [
  { id: "evt_01HZQ8R7XK", detail: "HTTP 503 from warehouse-webhook · retry 2/12", pill: "retry", label: "RETRY" },
  { id: "evt_01HZQ7N4WT", detail: "TLS handshake timeout · destination paused", pill: "dead", label: "DEAD" },
  { id: "evt_01HZQ6M2VR", detail: "Replay batch resolved · 11 deliveries", pill: "ok", label: "OK" },
  { id: "evt_01HZQ5L1UQ", detail: "Schema guard rejected · depth > 24", pill: "retry", label: "DROPPED" },
];

const routeRows = [
  { source: "stripe.webhooks", rule: "payments.live", dest: "mongo://orders", latency: "41ms" },
  { source: "github.webhooks", rule: "push.archive", dest: "s3://raw-ledger", latency: "68ms" },
  { source: "shopify.webhooks", rule: "orders.live", dest: "postgres://billing", latency: "37ms" },
  { source: "partner.webhook", rule: "fanout.signed", dest: "https://hooks.example", latency: "57ms" },
];

/* ----------------------------------------------------------------- */
/* Dashboard mock screenshots                                         */
/* ----------------------------------------------------------------- */

export function DashboardMock({ variant }: { variant: "hero" | "standalone" }) {
  const navSections: Array<{ label: string; items: Array<{ label: string; active?: boolean }> }> = [
    { label: "Activity", items: [{ label: "Overview", active: true }, { label: "Deliveries" }] },
    { label: "Pipeline", items: [{ label: "Sources" }, { label: "Routes" }, { label: "Destinations" }] },
    { label: "Workspace", items: [{ label: "Usage" }, { label: "Team" }, { label: "Settings" }] },
  ];

  const visibleKpis = variant === "hero" ? kpis.slice(0, 3) : kpis;

  return (
    <div className={`dashMock ${variant}`} aria-label="Mock Axel dashboard">
      <aside className="dashSidebar" aria-hidden="true">
        <div className="dashBrand">
          <span className="markGlyph"><Logo size={18} /></span>
          Axel
        </div>
        <div className="dashWorkspace">
          <span className="avatar">N</span>
          <div>
            <strong>Northwind</strong>
            <small>OWNER</small>
          </div>
        </div>
        {navSections.map((section) => (
          <div className="dashNavSection" key={section.label}>
            <span className="dashNavLabel">{section.label}</span>
            {section.items.map((item) => (
              <div className={`dashNavItem${item.active ? " active" : ""}`} key={item.label}>
                <span className="glyph" />
                {item.label}
              </div>
            ))}
          </div>
        ))}
        <div className="dashSidebarFoot">
          <span className="pulseDot" />
          All systems operational
        </div>
      </aside>

      <section className="dashMain">
        <header className="dashHeader">
          <div>
            <span className="eyebrow">Workspace overview</span>
            <h4>Overview</h4>
            <p>Welcome back. Here&apos;s what&apos;s happening across Northwind.</p>
          </div>
          <button type="button" className="headerBtn">See full usage →</button>
        </header>

        <div className={`dashKpis${variant === "hero" ? " kpis4" : ""}`}>
          {visibleKpis.map((kpi) => (
            <article className="kpiCard" key={kpi.label}>
              <span className="kpiLabel">{kpi.label}</span>
              <span className="kpiValue">{kpi.value}</span>
              {typeof kpi.delta === "number" ? (
                <DeltaPill
                  pct={kpi.delta}
                  {...(kpi.suffix !== undefined ? { suffix: kpi.suffix } : {})}
                  {...(kpi.inverse !== undefined ? { inverse: kpi.inverse } : {})}
                />
              ) : (
                <span className="kpiDelta neutral">{kpi.sub}</span>
              )}
            </article>
          ))}
        </div>

        <BarChartCard
          eyebrow="Volume · last 14 days"
          headline="1,241,790 events"
          sub="14.2 GB received · 8.2 GB raw payloads in R2"
          legendLabel="Events"
          legendColor="var(--chart-orange)"
          rows={eventBars.map((value, i) => ({ value, day: i }))}
          tone="events"
        />

        <BarChartCard
          eyebrow="Deliveries · last 14 days"
          headline="2,409,664 deliveries"
          sub="2.39M succeeded · 18,243 retried · 11 unresolved DLQ"
          legendLabel="Success / Failure"
          legendColor="var(--chart-green)"
          secondaryColor="var(--chart-rose)"
          rows={successBars.map((value, i) => ({
            value,
            failure: failureBars[i] ?? 0,
            day: i,
          }))}
          tone="deliveries"
        />

        <div className="dashLower">
          <article className="dashPanel">
            <div className="dashPanelHead">
              <h5>Top sources</h5>
              <div className="tabs">
                <span className="active">By events</span>
                <span>By bytes</span>
              </div>
            </div>
            {topSources.map((row) => (
              <div className="sourceRow" key={row.id}>
                <div>
                  <strong>{row.name}</strong>
                  <span className="meter"><i style={{ width: `${row.pct}%` }} /></span>
                </div>
                <small>{row.events}</small>
              </div>
            ))}
          </article>

          <article className="dashPanel">
            <div className="dashPanelHead">
              <h5>Activity</h5>
              <span className="seeAll">All deliveries →</span>
            </div>
            {activity.map((row) => (
              <div className="activityRow" key={row.id}>
                <div>
                  <code>{row.id}</code>
                  <span>{row.detail}</span>
                </div>
                <span className={`pill ${row.pill}`}>{row.label}</span>
              </div>
            ))}
          </article>
        </div>
      </section>
    </div>
  );
}

function DeltaPill({
  pct,
  suffix,
  inverse,
}: {
  pct: number;
  suffix?: string;
  inverse?: boolean;
}) {
  if (pct === 0) {
    return <span className="kpiDelta neutral">0%</span>;
  }
  const up = pct > 0;
  const positive = inverse ? !up : up;
  return (
    <span className={`kpiDelta ${positive ? "pos" : "neg"}`}>
      {up ? "↑" : "↓"} {up ? "+" : ""}
      {pct}
      {suffix ? ` ${suffix}` : "%"}
    </span>
  );
}

function BarChartCard({
  eyebrow,
  headline,
  sub,
  legendLabel,
  legendColor,
  secondaryColor,
  rows,
  tone,
}: {
  eyebrow: string;
  headline: string;
  sub: string;
  legendLabel: string;
  legendColor: string;
  secondaryColor?: string;
  rows: Array<{ value: number; failure?: number; day: number }>;
  tone: "events" | "deliveries";
}) {
  const focusIdx = rows.length - 1;
  return (
    <article className="dashChartCard">
      <div className="dashChartHead">
        <div>
          <span className="eyebrow">{eyebrow}</span>
          <span className="value">{headline}</span>
          <span className="sub">{sub}</span>
        </div>
        <div className="legend">
          <span>
            <i className="swatch" style={{ background: legendColor }} />
            {legendLabel}
          </span>
          {secondaryColor ? (
            <span>
              <i className="swatch" style={{ background: secondaryColor }} />
              Failure
            </span>
          ) : null}
        </div>
      </div>
      <div className="dashChartBody tall">
        <div className="dashBars" aria-hidden="true">
          {rows.map((row, i) => {
            const total = row.value + (row.failure ?? 0);
            const successPct = (row.value / 100) * 100;
            const failurePct = ((row.failure ?? 0) / 100) * 100;
            return (
              <div key={i} className="barCol" style={{ "--i": i } as CSSProperties}>
                <div
                  className={`bar${i === focusIdx ? " focus" : ""}`}
                  style={{ height: `${total}%` }}
                >
                  {tone === "deliveries" ? (
                    <>
                      <span
                        className="barFailure"
                        style={{ height: `${(failurePct / total) * 100}%` }}
                      />
                      <span
                        className="barSuccess"
                        style={{ height: `${(successPct / total) * 100}%` }}
                      />
                    </>
                  ) : (
                    <span className="barEvents" style={{ height: "100%" }} />
                  )}
                </div>
                {i % 2 === 0 ? <span className="axisLabel">{axisDates[i]}</span> : null}
              </div>
            );
          })}
        </div>
      </div>
    </article>
  );
}

/* ----------------------------------------------------------------- */
/* Pipeline trace mock                                                */
/* ----------------------------------------------------------------- */

export function PipelineMock() {
  const steps = [
    { num: "01", title: "Edge accepted", detail: "POST /v1/webhooks/in · 202", timing: "8ms" },
    { num: "02", title: "R2 persisted", detail: "shard=7 · 1.4KB · sha256:c2…3f", timing: "14ms" },
    { num: "03", title: "Route matched", detail: "filter payments.live · matched 1 of 3", timing: "23ms" },
    { num: "04", title: "MongoDB delivered", detail: "mongo://orders · POST · 200 OK", timing: "41ms" },
    { num: "05", title: "ClickHouse indexed", detail: "events.live · queued · partition=2026-06-16", timing: "queued", pending: true },
  ];
  return (
    <div className="pipelineMock">
      <h5>Event trace</h5>
      <span className="eventId">evt_01HZQ8R7XK · stripe.payments</span>
      <div className="pipelineSteps">
        {steps.map((step) => (
          <div className={`pipelineStep${step.pending ? " pending" : ""}`} key={step.num}>
            <span className="stepGlyph">{step.num}</span>
            <div>
              <strong>{step.title}</strong>
              <span className="detail">{step.detail}</span>
            </div>
            <span className="timing">{step.timing}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- */
/* Route mock                                                         */
/* ----------------------------------------------------------------- */

export function RouteMock() {
  return (
    <div className="routeMock">
      <div className="mockHead">
        <div>
          <span className="eyebrow">Routes</span>
          <h4>Live fan-out</h4>
        </div>
        <span className="statusPill">4 routes healthy</span>
      </div>
      <div className="routeTable">
        <div className="head">Source</div>
        <div className="head">Filter</div>
        <div className="head">Destination</div>
        <div className="head" style={{ textAlign: "right" }}>p95</div>
        {routeRows.map((row) => (
          <RouteRow key={row.source} row={row} />
        ))}
      </div>
    </div>
  );
}

function RouteRow({ row }: { row: typeof routeRows[number] }) {
  return (
    <>
      <div className="cell"><code>{row.source}</code></div>
      <div className="cell"><span className="tagLive">{row.rule}</span></div>
      <div className="cell"><code>{row.dest}</code></div>
      <div className="cell latency">{row.latency}</div>
    </>
  );
}

/* ----------------------------------------------------------------- */
/* Source detail mock                                                 */
/* ----------------------------------------------------------------- */

export function SourceMock() {
  return (
    <div className="sourceMock">
      <div className="sourceMockHead">
        <div className="titleBlock">
          <span className="eyebrow">Source detail</span>
          <h4>stripe.webhooks</h4>
        </div>
        <span className="statusPill">Active</span>
      </div>
      <div className="sourceMockGrid">
        <div className="cell"><span>Rate limit</span><strong>2,500/min</strong></div>
        <div className="cell"><span>Body cap</span><strong>256 KB</strong></div>
        <div className="cell"><span>Depth cap</span><strong>24</strong></div>
        <div className="cell"><span>Retries</span><strong>12×</strong></div>
      </div>
      <div className="sourceMockSparks">
        <div className="spark">
          <span>Events / 14d</span>
          <strong>612,403</strong>
          <Sparkline
            values={[34, 42, 38, 52, 48, 61, 56, 72, 64, 78, 71, 84, 88, 96]}
            color="var(--primary)"
          />
        </div>
        <div className="spark">
          <span>Success / 14d</span>
          <strong>99.998%</strong>
          <Sparkline
            values={[88, 92, 90, 95, 93, 96, 94, 97, 96, 98, 97, 98, 99, 100]}
            color="var(--chart-green)"
          />
        </div>
      </div>
      <pre className="sourceMockPayload">
{`{
  `}<span className="tok-key">&quot;event_id&quot;</span>{`: `}<span className="tok-str">&quot;evt_01HZQ8R7XK&quot;</span>{`,
  `}<span className="tok-key">&quot;source&quot;</span>{`: `}<span className="tok-str">&quot;stripe.webhooks&quot;</span>{`,
  `}<span className="tok-key">&quot;event&quot;</span>{`: `}<span className="tok-str">&quot;invoice.paid&quot;</span>{`,
  `}<span className="tok-key">&quot;customer&quot;</span>{`: `}<span className="tok-str">&quot;cus_PqJ8XKr&quot;</span>{`,
  `}<span className="tok-key">&quot;amount&quot;</span>{`: `}<span className="tok-num">14250</span>{`,
  `}<span className="tok-key">&quot;currency&quot;</span>{`: `}<span className="tok-str">&quot;usd&quot;</span>{`,
  `}<span className="tok-key">&quot;routes&quot;</span>{`: [`}<span className="tok-str">&quot;payments.live&quot;</span>{`]
}`}
      </pre>
    </div>
  );
}

function Sparkline({ values, color }: { values: number[]; color: string }) {
  const width = 200;
  const height = 38;
  const max = Math.max(1, ...values);
  const min = Math.min(0, ...values);
  const range = Math.max(1, max - min);
  const stepX = values.length > 1 ? width / (values.length - 1) : 0;
  const points = values.map((v, i) => {
    const x = i * stepX;
    const y = height - ((v - min) / range) * (height - 6) - 3;
    return [x, y] as const;
  });
  const linePath = points
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`)
    .join(" ");
  const first = points[0];
  const last = points[points.length - 1];
  const areaPath = first && last
    ? `${linePath} L${last[0].toFixed(2)} ${height} L${first[0].toFixed(2)} ${height} Z`
    : "";
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={areaPath} fill={color} opacity="0.14" />
      <path d={linePath} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      {last ? <circle cx={last[0]} cy={last[1]} r="2" fill={color} /> : null}
    </svg>
  );
}
