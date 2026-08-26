"use client";

/**
 * Hosts the static set of commands available in the Cmd-K palette.
 * Wraps `CommandPaletteProvider` so we can keep the command list
 * colocated with where the routes are defined (here, in the
 * dashboard chrome).
 *
 * Why "static" items live here instead of being prop-drilled in:
 *   - The same set of routes + create actions is available on every
 *     authenticated page. There's no per-page customization.
 *   - When we want page-aware items (recent destinations, e.g.) the
 *     parent layout can call `useCommandPalette().setItems([...static, ...recent])`
 *     after fetching. v1 is just the static set.
 */
import * as React from "react";
import {
  CommandPaletteProvider,
  type CommandItem,
} from "./CommandPalette";

const STATIC_COMMANDS: CommandItem[] = [
  // Navigate ---------------------------------------------------------
  { id: "nav:dashboard", section: "Navigate", label: "Go to dashboard", hint: "Workspace overview", glyph: "▦", to: "/dashboard", kind: "navigate", keywords: ["home", "overview"] },
  { id: "nav:sources", section: "Navigate", label: "Sources", hint: "Inbound webhook sources", glyph: "↘", to: "/sources", kind: "navigate", keywords: ["webhook", "ingest", "incoming"] },
  { id: "nav:destinations", section: "Navigate", label: "Destinations", hint: "Where events land", glyph: "↗", to: "/destinations", kind: "navigate", keywords: ["mongo", "postgres", "s3", "r2", "outbound"] },
  { id: "nav:routes", section: "Navigate", label: "Live pipelines", hint: "Approved route declarations", glyph: "⇄", to: "/routes", kind: "navigate", keywords: ["pipeline", "route", "wiring"] },
  { id: "nav:deliveries", section: "Navigate", label: "Deliveries", hint: "Failures + replay history", glyph: "▤", to: "/deliveries", kind: "navigate", keywords: ["failure", "failed deliveries", "replay", "errors"] },
  { id: "nav:events", section: "Navigate", label: "Events", hint: "Inbound event stream", glyph: "▣", to: "/events", kind: "navigate", keywords: ["webhook", "inbound", "received", "payloads", "ingest"] },
  { id: "nav:team", section: "Navigate", label: "Team", hint: "Members + invites", glyph: "◯", to: "/team", kind: "navigate", keywords: ["users", "invite", "members"] },
  { id: "nav:usage", section: "Navigate", label: "Usage", hint: "Volume + delivery health", glyph: "▥", to: "/usage", kind: "navigate", keywords: ["billing", "metrics", "volume"] },
  { id: "nav:settings", section: "Navigate", label: "Settings", hint: "Workspace + account", glyph: "⚙", to: "/settings", kind: "navigate", keywords: ["preferences", "account"] },

  // Create -----------------------------------------------------------
  // These deep-link to the list page where the create dialog lives.
  // The dialog is keyboard-openable from there ("New source" button).
  { id: "create:source", section: "Create", label: "New source", hint: "Add a webhook source", glyph: "+", to: "/sources?create=1", kind: "action", keywords: ["add", "ingest", "webhook in"] },
  { id: "create:pipeline_goal", section: "Create", label: "Make pipeline", hint: "Pick a source and destination, review a validated preview", glyph: "+", to: "/routes?create=1", kind: "action", keywords: ["pipeline", "route", "goal", "ai", "make"] },

  // Help -------------------------------------------------------------
  { id: "help:docs", section: "Help", label: "Open documentation", hint: "axelapp.ai/docs", glyph: "?", to: "https://axelapp.ai/docs", kind: "action" },
];

export function CommandPaletteSetup({ children }: { children: React.ReactNode }) {
  return (
    <CommandPaletteProvider initialItems={STATIC_COMMANDS}>
      {children}
    </CommandPaletteProvider>
  );
}
