#!/usr/bin/env node
/**
 * Re-runnable SEO/GEO benchmark for the Axel marketing site.
 *
 * Crawls every public route from a locally-running server (rendered HTML — what
 * Googlebot/Bingbot and AI answer-engine fetchers actually see), then scores:
 *   - Classic SEO: crawlability, indexation, titles, canonicals, OG, headings.
 *   - GEO (AI answer engines): structured data, answer-first content,
 *     query→answer-page mapping, extractable/quotable facts.
 *
 * NOTE on "across search engines and AI answer engines": we do NOT make live
 * calls to Google/Bing/Perplexity/ChatGPT — those are non-deterministic, gated,
 * and not reproducible in a loop. Instead we score the on-page signals each
 * class of engine consumes from the rendered page, which IS reproducible.
 *
 * Usage: BASE=http://localhost:3000 node seo-benchmark.mjs
 */

const BASE = process.env.BASE || "http://localhost:3000";
const PROD_ORIGIN = "https://axelapp.ai";

const ROUTES = [
  "/", "/pricing", "/docs", "/security",
  "/terms", "/privacy", "/dpa", "/subprocessors", "/acceptable-use",
  "/legal", "/cookies",
];

// Priority target queries → the page that should be the answer-ready surface.
// These are the intents Axel wants to win in search + AI answers.
const PRIORITY_QUERIES = [
  { q: "what is Axel", page: "/", intent: "brand/definition" },
  { q: "webhook to database sync", page: "/", intent: "category" },
  { q: "webhook delivery retries / recover failed webhook", page: "/", intent: "value" },
  { q: "webhook to data warehouse / S3 / Parquet", page: "/docs", intent: "capability" },
  { q: "Axel pricing / webhook sync cost", page: "/pricing", intent: "pricing" },
  { q: "webhook replay / retries", page: "/docs", intent: "capability" },
  { q: "how to ingest webhooks (quickstart)", page: "/docs", intent: "how-to" },
  { q: "is Axel secure / SOC2 / data handling", page: "/security", intent: "trust" },
  { q: "Axel free tier / how many events free", page: "/pricing", intent: "pricing" },
];

// ---------- tiny HTML helpers (no deps) ----------
const between = (html, re) => { const m = html.match(re); return m ? m[1].trim() : null; };
const all = (html, re) => Array.from(html.matchAll(re), (m) => m[1]);
const stripTags = (s) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

function parse(html) {
  const headTitle = between(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const metaDesc = between(html, /<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["']/i)
    || between(html, /<meta[^>]+content=["']([\s\S]*?)["'][^>]+name=["']description["']/i);
  const canonical = between(html, /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)
    || between(html, /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i);
  const robotsMeta = between(html, /<meta[^>]+name=["']robots["'][^>]+content=["']([^"']+)["']/i);
  const ogTitle = between(html, /<meta[^>]+property=["']og:title["'][^>]+content=["']([\s\S]*?)["']/i);
  const ogImage = between(html, /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  const ogDesc = between(html, /<meta[^>]+property=["']og:description["'][^>]+content=["']([\s\S]*?)["']/i);
  const twCard = between(html, /<meta[^>]+name=["']twitter:card["'][^>]+content=["']([^"']+)["']/i);
  const h1s = all(html, /<h1[^>]*>([\s\S]*?)<\/h1>/gi).map(stripTags).filter(Boolean);
  const h2s = all(html, /<h2[^>]*>([\s\S]*?)<\/h2>/gi).map(stripTags).filter(Boolean);
  const h3s = all(html, /<h3[^>]*>([\s\S]*?)<\/h3>/gi).map(stripTags).filter(Boolean);
  const ldBlocks = all(html, /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  const ldTypes = [];
  for (const b of ldBlocks) {
    try {
      const j = JSON.parse(b);
      const arr = Array.isArray(j) ? j : (j["@graph"] || [j]);
      for (const node of arr) if (node && node["@type"]) ldTypes.push(...[].concat(node["@type"]));
    } catch { ldTypes.push("PARSE_ERROR"); }
  }
  const internalLinks = all(html, /<a[^>]+href=["'](\/[^"'#?][^"']*)["']/gi);
  const bodyText = stripTags(between(html, /<body[^>]*>([\s\S]*?)<\/body>/i) || html);
  return { headTitle, metaDesc, canonical, robotsMeta, ogTitle, ogImage, ogDesc, twCard,
    h1s, h2s, h3s, ldTypes, internalLinks, bodyText, raw: html };
}

async function fetchText(path) {
  try {
    const r = await fetch(BASE + path, { redirect: "manual", headers: { "user-agent": "AxelSEOBench/1.0" } });
    const body = await r.text();
    return { status: r.status, body, ctype: r.headers.get("content-type") || "" };
  } catch (e) { return { status: 0, body: "", err: String(e) }; }
}

// ---------- scoring ----------
const results = [];
const add = (dim, sev, route, msg) => results.push({ dim, sev, route, msg }); // sev: critical|high|medium|low|ok

async function run() {
  // 1. Crawlability — robots.txt
  const robots = await fetchText("/robots.txt");
  if (robots.status !== 200) add("crawlability", "high", "/robots.txt", `robots.txt missing (status ${robots.status})`);
  else {
    add("crawlability", "ok", "/robots.txt", "robots.txt served");
    if (!/sitemap:/i.test(robots.body)) add("crawlability", "medium", "/robots.txt", "robots.txt has no Sitemap: directive");
    if (/disallow:\s*\/\s*$/im.test(robots.body)) add("crawlability", "critical", "/robots.txt", "robots.txt Disallow: / blocks whole site");
  }

  // 2. Indexation — sitemap.xml
  const sitemap = await fetchText("/sitemap.xml");
  let sitemapUrls = [];
  if (sitemap.status !== 200) add("indexation", "high", "/sitemap.xml", `sitemap.xml missing (status ${sitemap.status})`);
  else {
    sitemapUrls = all(sitemap.body, /<loc>([^<]+)<\/loc>/gi);
    add("indexation", "ok", "/sitemap.xml", `sitemap.xml served with ${sitemapUrls.length} urls`);
    const covered = new Set(sitemapUrls.map((u) => new URL(u).pathname.replace(/\/$/, "") || "/"));
    for (const r of ROUTES) if (!covered.has(r)) add("indexation", "medium", r, "route absent from sitemap");
  }

  // crawl pages
  const pages = {};
  for (const route of ROUTES) {
    const res = await fetchText(route);
    if (res.status !== 200) { add("crawlability", "critical", route, `route returned ${res.status}`); continue; }
    pages[route] = parse(res.body);
  }

  const titles = new Map();
  for (const [route, p] of Object.entries(pages)) {
    // 3/4 titles + descriptions
    if (!p.headTitle) add("metadata", "high", route, "no <title>");
    else {
      const len = p.headTitle.length;
      if (len > 65) add("titles", "low", route, `title ${len} chars (>65, may truncate)`);
      const key = p.headTitle.toLowerCase();
      titles.set(key, (titles.get(key) || []).concat(route));
    }
    if (!p.metaDesc) add("metadata", "high", route, "no meta description");
    else if (p.metaDesc.length < 50) add("metadata", "medium", route, `meta description ${p.metaDesc.length} chars (thin)`);

    // 2 canonical
    if (!p.canonical) add("indexation", "high", route, "no canonical link");
    else {
      try {
        if (new URL(p.canonical).origin !== PROD_ORIGIN) {
          add("indexation", "medium", route, `canonical not prod origin: ${p.canonical}`);
        }
      } catch {
        add("indexation", "medium", route, `canonical is not a valid URL: ${p.canonical}`);
      }
    }

    // 7 OG / Twitter
    if (!p.ogTitle || !p.ogDesc) add("opengraph", "medium", route, "missing og:title/og:description");
    if (!p.ogImage) add("opengraph", "medium", route, "no og:image");
    if (!p.twCard) add("opengraph", "low", route, "no twitter:card");

    // 9 headings
    if (p.h1s.length === 0) add("headings", "high", route, "no <h1>");
    else if (p.h1s.length > 1) add("headings", "medium", route, `${p.h1s.length} <h1> tags`);

    // 6 structured data
    if (p.ldTypes.length === 0) add("structured-data", route === "/" ? "high" : "medium", route, "no JSON-LD structured data");
    if (p.ldTypes.includes("PARSE_ERROR")) add("structured-data", "high", route, "JSON-LD failed to parse");
  }

  // duplicate titles
  for (const [t, rs] of titles) if (rs.length > 1) add("titles", "medium", rs.join(","), `duplicate title "${t}"`);

  // homepage should carry Organization + SoftwareApplication; pricing/docs FAQPage
  const home = pages["/"];
  if (home) {
    for (const need of ["Organization", "SoftwareApplication", "WebSite"])
      if (!home.ldTypes.includes(need)) add("structured-data", "high", "/", `homepage missing ${need} JSON-LD`);
  }
  // AI answer engines favor FAQ/QA/HowTo schema. Pricing + homepage should carry
  // FAQPage; docs is a how-to page so HowTo (or FAQPage) is the correct schema.
  for (const r of ["/pricing", "/"]) {
    if (pages[r] && !pages[r].ldTypes.includes("FAQPage"))
      add("structured-data", "medium", r, "no FAQPage JSON-LD (AI answer engines favor FAQ schema)");
  }
  if (pages["/docs"] && !["FAQPage", "HowTo", "QAPage"].some((t) => pages["/docs"].ldTypes.includes(t)))
    add("structured-data", "medium", "/docs", "no FAQPage/HowTo JSON-LD (AI answer engines favor Q&A/step schema)");

  // 5 internal links — orphan / cross-link check among core product pages
  const core = ["/", "/pricing", "/docs", "/security"];
  for (const r of core) {
    const p = pages[r]; if (!p) continue;
    const links = new Set(p.internalLinks.map((l) => l.replace(/\/$/, "") || "/"));
    const outToCore = core.filter((c) => c !== r && links.has(c));
    if (outToCore.length < 2) add("internal-links", "medium", r, `links to only ${outToCore.length} other core page(s): [${outToCore}]`);
  }

  // 8 answer-first / GEO query mapping
  const geo = [];
  for (const { q, page, intent } of PRIORITY_QUERIES) {
    const p = pages[page];
    if (!p) { geo.push({ q, page, intent, score: 0, why: "page missing" }); continue; }
    let score = 0; const why = [];
    if (p.h1s.length === 1) { score += 1; why.push("single h1"); }
    // FAQ-style question headings improve extractability
    const qHeads = [...p.h2s, ...p.h3s].filter((h) => /\?$/.test(h) || /^(how|what|why|when|can|does|is)\b/i.test(h));
    if (qHeads.length) { score += 1; why.push(`${qHeads.length} question-style headings`); }
    if (["FAQPage", "HowTo", "QAPage"].some((t) => p.ldTypes.includes(t))) { score += 1; why.push("Q&A/HowTo schema"); }
    if (p.ldTypes.includes("SoftwareApplication") || p.ldTypes.includes("Product") || p.ldTypes.includes("Offer")) { score += 1; why.push("product schema"); }
    // does the page text actually contain terms from the query?
    const terms = q.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 3);
    const hits = terms.filter((t) => p.bodyText.toLowerCase().includes(t)).length;
    if (terms.length && hits / terms.length >= 0.5) { score += 1; why.push("query terms present"); }
    geo.push({ q, page, intent, score, max: 5, why: why.join(", ") });
    if (score < 3) add("answer-first", "medium", page, `query "${q}" weakly answered (score ${score}/5: ${why.join(", ") || "no signals"})`);
  }

  // ---------- report ----------
  const order = { critical: 0, high: 1, medium: 2, low: 3, ok: 4 };
  const issues = results.filter((r) => r.sev !== "ok").sort((a, b) => order[a.sev] - order[b.sev]);
  const counts = {};
  for (const r of results) counts[r.sev] = (counts[r.sev] || 0) + 1;

  console.log("\n=== AXEL SEO/GEO BENCHMARK ===");
  console.log(`base=${BASE}  routes=${Object.keys(pages).length}/${ROUTES.length}  sitemapUrls=${sitemapUrls.length}`);
  console.log(`severity: critical=${counts.critical||0} high=${counts.high||0} medium=${counts.medium||0} low=${counts.low||0} ok=${counts.ok||0}`);

  console.log("\n--- ISSUES (ranked) ---");
  for (const i of issues) console.log(`[${i.sev.toUpperCase().padEnd(8)}] ${i.dim.padEnd(16)} ${i.route.padEnd(16)} ${i.msg}`);

  console.log("\n--- GEO query → answer-page readiness ---");
  for (const g of geo) console.log(`  ${String(g.score)}/5  ${g.page.padEnd(10)} "${g.q}"  (${g.why || "—"})`);
  const geoAvg = (geo.reduce((s, g) => s + g.score, 0) / geo.length).toFixed(2);
  const mapped = geo.filter((g) => g.score >= 3).length;

  console.log("\n--- SCORE ---");
  const critical = counts.critical || 0, high = counts.high || 0;
  console.log(`technical: ${critical} critical, ${high} high  | GEO avg ${geoAvg}/5, ${mapped}/${geo.length} queries answer-ready (>=3)`);
  const clean = critical === 0 && high === 0 && mapped === geo.length;
  console.log(`CONVERGED: ${clean ? "YES ✅" : "NO ❌"}`);
  console.log("");

  // machine-readable tail for diffing across runs
  console.log("JSON " + JSON.stringify({ critical, high, medium: counts.medium||0, low: counts.low||0, geoAvg: Number(geoAvg), mapped, total: geo.length, converged: clean }));
}

run();
