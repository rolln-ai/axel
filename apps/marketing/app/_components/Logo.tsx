/**
 * Axel brand mark — marketing-site copy.
 *
 * Kept identical to the dashboard's `_brand/Logo.tsx` so the same shape
 * appears across surfaces. (We duplicate intentionally rather than depend
 * — the marketing site avoids extra workspace deps to keep the Vercel
 * build minimal.)
 *
 * A hub-and-spoke wheel (the "axle"): one central hub with six spokes
 * radiating to a segmented outer rim — one event fanning out to many
 * destinations. See the dashboard Logo.tsx for the full design rationale.
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
