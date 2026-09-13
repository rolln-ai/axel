# UI design

How to build UI in this repo that matches what's already here. Read this
before you create or change anything a user sees. It covers both Next.js
apps:

- `apps/dashboard` is the product (Tailwind v4, shadcn/ui). Most of this file
  is about it.
- `apps/marketing` is axelapp.ai (hand-written CSS, no Tailwind). See
  "Marketing app" near the end; its rules differ.

Use the tokens and components linked below. If these instructions disagree
with the code, check the implementation and update this file.

## Ground rules

1. Use semantic tokens for new work. Do not add a hex value, `oklch()`, or an
   arbitrary-value color class (`text-[#f54e00]`) to a component. Success and
   warning states use the documented Tailwind palette classes below. A few
   route-canvas and `EdaPanel.tsx` colors are legacy drift to migrate, not
   precedent for new code.
2. Reuse before you build. Check `components/ui/` (shadcn primitives) and
   `app/_components/` (app composites) first. If a pattern appears a third
   time, extract it into `app/_components/` with a docblock saying why it
   exists and what it replaced.
3. Do not invent type sizes, radii, or spacing. Start with the preferred scales
   below. Existing screens still contain broader Tailwind scale values where
   their layout requires them.
4. Both themes, always. The dashboard defaults to dark and ships light too.
   Check every change in both; the toggle is in the sidebar footer.

## Where things live

| What | Where |
| --- | --- |
| Design tokens (canonical) | `apps/dashboard/app/globals.css` |
| shadcn primitives | `apps/dashboard/components/ui/` (kebab-case files) |
| App composites | `apps/dashboard/app/_components/` (PascalCase files) |
| Logo and icon | `apps/dashboard/app/_brand/` |
| `cn()` helper | `apps/dashboard/lib/utils.ts`, import from `@/lib/utils` |
| App shell, nav, workspace switcher | `apps/dashboard/app/AppShell.tsx`, `AppNav.tsx`, `WorkspaceSwitcher.tsx` |
| Drawer | `apps/dashboard/app/_components/PanelStack.tsx`, `QuickView.tsx` |
| Marketing tokens | `apps/marketing/app/globals.css` (top of file) |

## Brand

Axel is a webhook ingestion and delivery platform. Use compact layouts, warm neutrals, one orange accent, and monospace numbers.

- The mark is a hub-and-spoke wheel: six spokes at 60°, segmented rim, copper
  gradient. In the dashboard, render it with `app/_brand/Logo.tsx`
  (`tone="copper" | "current"`, `variant="wordmark"`). Marketing uses its own
  `app/_components/Logo.tsx` and `lib/logo-mark.tsx` implementations. Do not
  add another rendition, redraw the mark, recolor it, or stretch it.
- Brand orange is the only accent: `#f54e00` in light, lifted to `#ff7a3a` in
  dark. It reaches you as `--primary`; use `bg-primary`, `text-primary`,
  never the hex.

## Color

Reach for tokens by role:

- Page: `bg-background text-foreground`
- Surfaces: `bg-card` with `border border-border` (cards, sections, popovers)
- Secondary fills: `bg-secondary` / `bg-muted` / `bg-accent` (same value
  today; pick by meaning)
- De-emphasized text: `text-muted-foreground`
- Errors and destructive actions: `text-destructive` with tinted fills
  (`bg-destructive/10`), never a solid red block
- Focus: `ring` already matches primary; don't restyle focus rings
- Charts: `--chart-1` through `--chart-5` (orange, green, amber, rose, grey),
  in that order

The palettes are deliberate. Light is warm ivory (`#f7f7f4` base); dark is
warm espresso (`#1a1814` base, rather than pure black). Dark-mode borders are white at 10% alpha, not grey hexes.

Check text contrast. `--muted-foreground` in light was darkened from
`#7a7974` to `#6a6964` to clear WCAG AA 4.5:1 on the ivory background. Never
lighten a grey to make it "subtler"; check contrast instead.

**Success and warning states.** There is no semantic
token for these yet, so the codebase uses Tailwind palette classes. Use only
these families, in these pairings, so the theme stays coherent:

| State | Text | Tinted fill |
| --- | --- | --- |
| Success | `text-emerald-600 dark:text-emerald-400` | `bg-emerald-500/10` |
| Warning | `text-amber-600 dark:text-amber-400` | `bg-amber-500/10` |
| Failure | `text-destructive` | `bg-destructive/10` |

Do not introduce `green`, `yellow`, `red`, or `rose` for new states; older
files that use them are drift, not precedent. Adding `--success` and
`--warning` tokens to `globals.css` and migrating these is the intended fix.

## Typography

The dashboard uses the system font stack. Do not add webfonts to it.
`font-mono` is for identifiers, payloads, timestamps, and KPI values.

| Role | Classes |
| --- | --- |
| Page title (h1, `PageHeader`) | `text-3xl font-semibold tracking-tight md:text-4xl` |
| Section heading (h2) | `text-sm font-semibold` |
| Body and controls | `text-sm` |
| Metadata, helper text | `text-xs text-muted-foreground` |
| KPI value (`KpiCard`) | `font-mono text-4xl font-semibold tracking-tight` |
| Micro-labels (stat labels, filter labels, drawer eyebrows, nav groups) | `text-[11px] font-medium uppercase tracking-wider text-muted-foreground` (nav groups: no uppercase) |

All headings, buttons, and labels use sentence case: "Failed deliveries",
not "Failed Deliveries".

## Density and spacing

This is a compact, tool-like UI. Sizes run one step smaller than stock shadcn:

- Buttons: `h-8` default, `h-7` sm, `h-6` xs; `h-9` is the large size, used
  rarely
- Badges: `h-5`, `text-xs`, pill radius (`rounded-4xl`)
- Gaps: `gap-1.5`, `gap-2`, `gap-3`
- Card padding: `p-4` (stat cards), `p-5` (section bodies), `p-6` (dashboard
  panels)
- Surface radius: `rounded-lg` for sections and tables, `rounded-xl` for
  dashboard KPI and chart cards; the whole radius scale is computed from
  `--radius`, so don't hardcode other radii

Page rhythm: `PageHeader` owns `mb-8 pb-6`; `Section` owns `mt-6`. Don't add
competing vertical margins around them.

## Composition

Build pages from the existing composites:

- `PageHeader` for every page: optional eyebrow, h1, `max-w-2xl`
  description, right-aligned actions on desktop.
- `Section` for card sections: bordered `bg-card` surface, header row
  (`px-5 py-3`, `text-sm font-semibold` h2, optional pill), body
  `space-y-3 p-5`.
- `KpiCard` for metric rows (mono value, delta pill or caption), `StatCard`
  for smaller stat tiles.
- Use `EntityStatusBadge`, `ReplayStateBadge`, `DeliveryStatusBadge`, and
  `SeverityBadge` from `StatusBadges.tsx` for those supported status domains.
  Do not reimplement their mappings inline. Domain-specific states such as
  billing may keep a local mapping until the same pattern is repeated.
- `PanelStack` / `QuickView` for drill-in detail: a 560px right-side drawer
  (420px when stacked), blurred backdrop, uppercase eyebrow over the title,
  `X` to close, optional `bg-muted/30` footer with "Open full page". Use it
  for previews; anything that needs its own URL gets a route.
- `AppShell` owns page geometry (sticky `md:w-64` sidebar on `bg-sidebar`,
  main content `px-4 py-4 pt-14 md:px-8 md:py-6 md:pt-6`). Keep page spacing consistent with it.
- `OverviewChart.tsx` is server-rendered inline SVG. `EdaPanel.tsx` is the sole
  Recharts chart. Series colors come from the chart tokens; migrate the legacy
  hex values in `EdaPanel.tsx` to `var(--chart-n)` when touching that chart.

Skeletons must match the real component's box model exactly so `loading.tsx`
causes no layout shift. `PageHeaderSkeleton` is the reference; if you change
a component's dimensions, change its skeleton in the same commit.

## Component conventions

- `cn()` from `@/lib/utils` for all class merging.
- Variants via `cva`; primitives emit `data-slot`, `data-variant`, and
  `data-size` attributes.
- Named groups: `group/button`, `group/badge`.
- `asChild` uses `Slot.Root` from the unified `radix-ui` package.
- Tailwind v4 selector idioms are house style (`has-data-[...]`,
  `in-data-[...]`, `aria-expanded:`), preferred over wrapper divs and JS
  state.
- Icons are `lucide-react` at `size-4`; no emoji, no other icon sets.
- Shared components open with a docblock stating why they exist and what they
  replaced.

## UI copy

- Sentence case for headings, buttons, and labels.
- Start instructions with a verb.
- Use the product vocabulary exactly: source, route, destination, delivery
  attempt, retry, replay, dead letter, failed-deliveries inbox. Don't
  introduce synonyms.
- No emoji in product copy. No exclamation points in errors.
- State what happened and what the user can do. No cheerleading.

## Review checklist

Reject these changes:

1. **New raw color.** Hex, oklch, or arbitrary-value color classes added to components.
2. **Palette drift.** Any Tailwind color family other than the emerald/amber
   pairs above for state colors.
3. **Solid-red destructive.** Destructive buttons and badges are tinted,
   never a filled red block.
4. **Stock-shadcn sizing.** Upstream shadcn markup pasted in with `h-9`/`h-10`
   controls, oversized for this compact UI.
5. **Title case labels.** Headings, buttons, and labels are sentence case.
6. **Duplicated status mapping.** Entity, replay, delivery, or severity colors
   reimplemented outside `StatusBadges.tsx`.
7. **Mismatched skeletons.** Loading states with different dimensions than
   the loaded state.
8. **Decorative gradients and glows.** Hero gradients, glassmorphism, or
   purple "AI shimmer" anywhere in the product. The copper gradient belongs
   to the logo only.
9. **One-theme changes.** Anything checked in only one of light/dark.
10. **Webfonts in the dashboard.** The system stack is intentional.
11. **Redrawn logo.** Any new Axel mark outside the dashboard and marketing
    implementations named above.

## Marketing app

`apps/marketing` uses a separate styling system:

- No Tailwind, no shadcn. One hand-written stylesheet at
  `apps/marketing/app/globals.css` with component-based class names. Extend it in
  place; do not introduce Tailwind or component libraries.
- Its own token names (`--bg`, `--surface`, `--ink`, `--muted`, `--primary`),
  dark-only, values mirroring the dashboard's dark palette. If you change a
  shared value (for example brand orange), change it in both apps.
- Fonts are Geist and Geist Mono via `next/font`, local TTFs in `app/_fonts/`.

## Checking your work

- `pnpm visual:smoke` runs the Playwright visual suite (desktop 1440×1000,
  mobile 390×844). Run it after any UI change; update snapshots only when the
  change is intended.
- Check both themes and both viewports by hand for anything the suite doesn't
  cover.
- `pnpm lint && pnpm typecheck` as usual.
