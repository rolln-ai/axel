import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AxelMark } from "../lib/logo-mark";

/**
 * Global Open Graph / Twitter card image. As a root-level file-convention
 * route it applies to every page and overrides config-based images, so each
 * route gets a branded 1200x630 card on social + AI answer-engine previews.
 *
 * The card mirrors the homepage hero: same headline, same copper accent on
 * "your data stack", same dashboard bleeding off the right edge. Someone who
 * clicks the card should land on a page that looks like the card.
 *
 * Two things this file learned the hard way about Satori, the renderer behind
 * next/og:
 *
 *  - `fontFamily: "sans-serif"` renders in whatever the runtime has, which is
 *    not Geist. Satori needs the actual font bytes, so the two weights the card
 *    uses are committed next door in `_fonts/` and passed in below.
 *  - Satori does not blur `radial-gradient`. The previous card asked for a soft
 *    copper glow and got a hard-edged rectangle across the artwork. The warmth
 *    now comes from a flat wash with no edge inside the frame.
 */
export const runtime = "nodejs";
export const alt = "Axel — capture webhooks and deliver them to your data stack";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/** Straight from the marketing palette in app/globals.css. */
const BG = "#1a1814";
const INK = "#f0eee5";
const MUTED = "#a09e96";
const PRIMARY = "#ff7a3a";
const COPPER = "#d98a5a";

export default async function OpengraphImage() {
  // Literal paths, not a join() helper: Next traces the files a route reads by
  // analysing the source, and a computed path can be missed — which fails only
  // once deployed. next.config.mjs also names _fonts in outputFileTracingIncludes.
  const [dashboard, geist, geistSemibold] = await Promise.all([
    readFile(join(process.cwd(), "app", "opengraph-dashboard.png")),
    readFile(join(process.cwd(), "app", "_fonts", "Geist-Regular.ttf")),
    readFile(join(process.cwd(), "app", "_fonts", "Geist-SemiBold.ttf")),
  ]);
  const dashboardSrc = `data:image/png;base64,${dashboard.toString("base64")}`;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          background: BG,
          fontFamily: "Geist",
          position: "relative",
        }}
      >
        {/* Left column — wordmark, headline, lede. Mirrors the hero. */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            width: 660,
            padding: "62px 0 62px 64px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <AxelMark size={40} />
            <div style={{ fontSize: 30, fontWeight: 600, color: INK, letterSpacing: -0.5 }}>
              Axel
            </div>
          </div>

        {/*
          Two stacked blocks rather than one line with a coloured <span>.
          Satori lays a nested span out as a sibling flex item, so an inline
          accent does not wrap with the sentence — it runs off the edge. The
          hero breaks in exactly this place anyway, so stacking reproduces the
          page and sidesteps the problem.
        */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              fontSize: 56,
              fontWeight: 600,
              lineHeight: 1.04,
              marginTop: 32,
              letterSpacing: -2,
              maxWidth: 570,
            }}
          >
            <div style={{ display: "flex", color: INK }}>
              Capture webhooks and deliver them to
            </div>
            <div style={{ display: "flex", color: PRIMARY }}>your data stack.</div>
          </div>

          <div
            style={{
              display: "flex",
              fontSize: 22,
              color: MUTED,
              marginTop: 30,
              maxWidth: 530,
              lineHeight: 1.45,
            }}
          >
            The original payload is stored before Axel returns 202. Failed deliveries retry, and
            you can replay from the dashboard.
          </div>
        </div>

        {/* Dashboard bleeding off the right edge, as on the homepage. */}
        <div
          style={{
            display: "flex",
            position: "absolute",
            top: 74,
            left: 664,
            width: 600,
            height: 482,
            borderRadius: "12px 0 0 12px",
            border: "1px solid rgba(240,238,229,0.14)",
            borderRight: "none",
            backgroundImage: `url(${dashboardSrc})`,
            backgroundSize: "980px 700px",
            backgroundPosition: "0 0",
            boxShadow: "0 30px 80px -30px rgba(0,0,0,0.7)",
          }}
        />

        {/* url, bottom-right */}
        <div
          style={{
            position: "absolute",
            bottom: 40,
            right: 64,
            fontSize: 22,
            fontWeight: 600,
            color: COPPER,
          }}
        >
          axelapp.ai
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: "Geist", data: geist, weight: 400, style: "normal" },
        { name: "Geist", data: geistSemibold, weight: 600, style: "normal" },
      ],
    },
  );
}
