/**
 * Axel brand mark — a hub-and-spoke wheel (the "axle").
 *
 * A single central hub with six spokes radiating to a segmented outer rim.
 * It reads as one event in the middle fanning out to many destinations —
 * the product's hub-and-spoke routing model — and puns on the name (an axle
 * is the hub of a spoked wheel).
 *
 * Design notes:
 *   - Six spokes ("fan-out to many") at 60° apart, first spoke pointing up.
 *   - The rim is broken into six arcs with small gaps centered between the
 *     spokes; each spoke meets the middle of a solid arc. The gaps keep the
 *     mark from reading as a plain filled disc and give it the stencil/cut
 *     character of the reference.
 *   - Single, uniform stroke weight with round caps — clean and confident.
 *   - Authored on a 48-unit box so it stays crisp scaled up to the marketing
 *     hero and down to ~20px app chrome (on retina, a 24px mark is 48 device px).
 *
 * Color:
 *   - `tone="copper"` (default) paints the mark with the brand copper gradient
 *     (#f2b98c → #d98a5a → #b35f36). It's legible on the espresso surfaces and
 *     on the dashboard's near-white light sidebar alike.
 *   - `tone="current"` falls back to `currentColor` for single-color contexts
 *     (print, monochrome, a surface where the gradient would clash).
 *
 * The favicon (`app/icon.svg`) is a chunkier, tab-optimized copy of this shape
 * on an espresso rounded-rect — it lives at 16px and earns its own geometry.
 *
 * Usage:
 *   <Logo />                          — 22px copper mark
 *   <Logo size={32} />                — explicit size
 *   <Logo variant="wordmark" />       — mark + copper "Axel"
 *   <Logo tone="current" />           — single-color (currentColor) mark
 *
 * No React hooks here so the component renders inside Server Components. The
 * gradient uses one stable id; every instance defines an identical gradient,
 * so duplicate-id resolution is visually harmless.
 */
import * as React from "react";

export interface LogoProps extends React.SVGProps<SVGSVGElement> {
  /** Pixel size of the square mark. Default 22 (sidebar size). */
  size?: number;
  /** Render variant. */
  variant?: "mark" | "wordmark";
  /** Mark color treatment. Default "copper" (brand gradient). */
  tone?: "copper" | "current";
  /** Wordmark color override (only when tone="current"). Defaults to currentColor. */
  wordColor?: string;
  className?: string;
}

// ---- wheel geometry (48-unit box) -------------------------------------------
// Parametric so the proportions are easy to reason about; evaluated once at
// module load into static path strings.
const VB = 48; // viewBox size
const C = VB / 2; // center
const RIM = 19; // rim radius
const HUB = 6; // hub ring radius
const STROKE = 2.4; // uniform stroke weight
const SPOKES = 6;
const GAP_DEG = 12; // angular width of each rim gap (sits between spokes)
const START_DEG = -90; // first spoke points up
const STEP = 360 / SPOKES;
const HALF_ARC = STEP / 2 - GAP_DEG / 2; // half-width of each rim arc

const GRADIENT_ID = "axel-copper";
const COPPER_STOPS = ["#f2b98c", "#d98a5a", "#b35f36"] as const;
const COPPER_TEXT = `linear-gradient(157deg, ${COPPER_STOPS[0]} 0%, ${COPPER_STOPS[1]} 50%, ${COPPER_STOPS[2]} 100%)`;

const rad = (deg: number) => (deg * Math.PI) / 180;
const onCircle = (r: number, deg: number) =>
  `${(C + r * Math.cos(rad(deg))).toFixed(2)} ${(C + r * Math.sin(rad(deg))).toFixed(2)}`;

const RIM_ARCS = Array.from({ length: SPOKES }, (_, k) => {
  const a = START_DEG + k * STEP;
  return `M ${onCircle(RIM, a - HALF_ARC)} A ${RIM} ${RIM} 0 0 1 ${onCircle(RIM, a + HALF_ARC)}`;
});
const SPOKE_LINES = Array.from({ length: SPOKES }, (_, k) => {
  const a = START_DEG + k * STEP;
  return `M ${onCircle(HUB + STROKE * 0.1, a)} L ${onCircle(RIM - STROKE * 0.55, a)}`;
});

export function Logo({
  size = 22,
  variant = "mark",
  tone = "copper",
  wordColor,
  className,
  ...rest
}: LogoProps) {
  const stroke = tone === "copper" ? `url(#${GRADIENT_ID})` : "currentColor";

  const mark = (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${VB} ${VB}`}
      role="img"
      aria-label="Axel"
      fill="none"
      {...rest}
    >
      {tone === "copper" && (
        <defs>
          <linearGradient
            id={GRADIENT_ID}
            x1={VB * 0.3}
            y1={0}
            x2={VB * 0.7}
            y2={VB}
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0" stopColor={COPPER_STOPS[0]} />
            <stop offset="0.5" stopColor={COPPER_STOPS[1]} />
            <stop offset="1" stopColor={COPPER_STOPS[2]} />
          </linearGradient>
        </defs>
      )}
      <g
        stroke={stroke}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {RIM_ARCS.map((d, i) => (
          <path key={`rim-${i}`} d={d} />
        ))}
        {SPOKE_LINES.map((d, i) => (
          <path key={`spoke-${i}`} d={d} />
        ))}
        <circle cx={C} cy={C} r={HUB} />
      </g>
    </svg>
  );

  if (variant === "mark") return mark;

  const wordStyle: React.CSSProperties =
    tone === "copper"
      ? {
          backgroundImage: COPPER_TEXT,
          WebkitBackgroundClip: "text",
          backgroundClip: "text",
          color: "transparent",
        }
      : { color: wordColor ?? "currentColor" };

  return (
    <span
      className={`logoWordmark${className ? ` ${className}` : ""}`}
      style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
    >
      {mark}
      <span
        style={{
          fontWeight: 600,
          fontSize: 15,
          letterSpacing: "-0.01em",
          ...wordStyle,
        }}
      >
        Axel
      </span>
    </span>
  );
}
