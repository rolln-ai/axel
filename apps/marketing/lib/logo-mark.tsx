/**
 * Satori-renderable Axel mark for rasterized brand assets (next/og routes:
 * /email-logo and the root opengraph-image). Rendered as inline <svg> JSX
 * children of ImageResponse — the satori-supported path; an <img> with an SVG
 * data URI fails to decode in production, don't go back to that.
 *
 * Geometry duplicated from app/_components/Logo.tsx (same constants; keep in
 * sync). The interactive site keeps using <Logo>; this exists because email
 * clients and social crawlers need PNGs.
 */

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

const COPPER_STOPS = ["#f2b98c", "#d98a5a", "#b35f36"] as const;

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

/** The hub-and-spoke wheel at `size` px, copper gradient strokes. */
export function AxelMark({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${VB} ${VB}`}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient
          id="axel-copper"
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
      <g
        stroke="url(#axel-copper)"
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
}
