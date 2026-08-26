"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

/**
 * Last-resort error boundary. Catches errors thrown by the root layout
 * itself (and any unhandled errors not caught by deeper `error.tsx`
 * boundaries) so users never see Next.js's bare "ERROR ########"
 * default. Most often this fires when `requireSession()` in
 * `(app)/layout.tsx` throws on a transient Postgres pooler blip — the
 * AXE-95 cluster. Sentry still captures these via the instrumentation
 * hook; this file only owns the user-facing render.
 *
 * global-error replaces the entire document tree, so it must include
 * its own <html>/<body> — at the moment it renders, the root layout is
 * the thing that failed.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
    console.error("[dashboard global]", error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          background: "#f7f5f1",
          color: "#1a1a1a",
          fontFamily:
            "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
          padding: "24px",
        }}
      >
        <main
          role="alert"
          style={{
            maxWidth: 420,
            background: "#fff",
            border: "1px solid #e6e1d8",
            borderRadius: 12,
            padding: 24,
            textAlign: "center",
          }}
        >
          <h1 style={{ fontSize: 18, fontWeight: 600, margin: "0 0 8px" }}>
            Axel hit a snag loading this page
          </h1>
          <p style={{ fontSize: 14, color: "#5b5b5b", margin: "0 0 16px" }}>
            Usually a transient database blip — try reloading. If it keeps
            failing, check the{" "}
            <a
              href="/status"
              style={{ color: "#d96c06", textDecoration: "underline" }}
            >
              status page
            </a>
            .
          </p>
          {error.digest ? (
            <code
              style={{
                display: "inline-block",
                background: "#f3efe8",
                padding: "4px 8px",
                borderRadius: 4,
                fontFamily:
                  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
                fontSize: 11,
                color: "#5b5b5b",
                marginBottom: 16,
              }}
            >
              {error.digest}
            </code>
          ) : null}
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              gap: 8,
              marginTop: 8,
            }}
          >
            <button
              type="button"
              onClick={() => reset()}
              style={{
                background: "#d96c06",
                color: "#fff",
                border: 0,
                padding: "8px 16px",
                borderRadius: 6,
                fontSize: 14,
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              Try again
            </button>
            <a
              href="/dashboard"
              style={{
                background: "transparent",
                color: "#1a1a1a",
                border: "1px solid #e6e1d8",
                padding: "8px 16px",
                borderRadius: 6,
                fontSize: 14,
                fontWeight: 500,
                textDecoration: "none",
              }}
            >
              Back to dashboard
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}
