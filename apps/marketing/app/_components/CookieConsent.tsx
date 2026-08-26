"use client";

import { type CSSProperties, useEffect, useState } from "react";
import {
  CONSENT_PREFERENCES_EVENT,
  consentDecisionPending,
  disableAnalytics,
  enableAnalytics,
  writeConsent,
} from "../../lib/consent";

/**
 * Cookie-consent banner. Shows only when consent is required (EEA/UK/CH or
 * unknown geo) and the visitor hasn't decided yet — or when they re-open it via
 * the footer "Cookie preferences" control. Accepting starts PostHog; declining
 * keeps it off and clears any analytics cookies.
 */
export function CookieConsent() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (consentDecisionPending()) setOpen(true);
    const reopen = () => setOpen(true);
    window.addEventListener(CONSENT_PREFERENCES_EVENT, reopen);
    return () => window.removeEventListener(CONSENT_PREFERENCES_EVENT, reopen);
  }, []);

  if (!open) return null;

  const accept = () => {
    writeConsent("granted");
    enableAnalytics();
    setOpen(false);
  };
  const decline = () => {
    writeConsent("denied");
    disableAnalytics();
    setOpen(false);
  };

  return (
    <div role="dialog" aria-label="Cookie consent" aria-live="polite" style={wrap}>
      <div style={card}>
        <p style={text}>
          We use a privacy-friendly analytics cookie (PostHog) to see how Axel is used and improve it.
          Strictly-necessary cookies always run. Read our{" "}
          <a href="/cookies" style={link}>
            Cookie Policy
          </a>
          .
        </p>
        <div style={actions}>
          <button type="button" onClick={decline} style={declineBtn}>
            Decline
          </button>
          <button type="button" onClick={accept} style={acceptBtn}>
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}

const wrap: CSSProperties = {
  position: "fixed",
  insetInline: 0,
  bottom: 0,
  zIndex: 60,
  display: "flex",
  justifyContent: "center",
  padding: "16px",
  pointerEvents: "none",
};

const card: CSSProperties = {
  pointerEvents: "auto",
  width: "100%",
  maxWidth: 760,
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: 16,
  background: "var(--surface, #232017)",
  color: "var(--ink, #f0eee5)",
  border: "1px solid var(--line, rgba(240,238,229,0.12))",
  borderRadius: 14,
  padding: "14px 18px",
  boxShadow: "0 16px 48px rgba(0,0,0,0.5)",
};

const text: CSSProperties = {
  flex: "1 1 320px",
  margin: 0,
  fontSize: 13.5,
  lineHeight: 1.5,
  color: "var(--ink-2, #d8d6cc)",
};

const link: CSSProperties = {
  color: "var(--primary, #ff7a3a)",
  textDecoration: "underline",
  textUnderlineOffset: 2,
};

const actions: CSSProperties = { display: "flex", gap: 10, flex: "0 0 auto" };

const btnBase: CSSProperties = {
  font: "inherit",
  fontSize: 13,
  fontWeight: 600,
  borderRadius: 10,
  padding: "9px 16px",
  cursor: "pointer",
  border: "1px solid transparent",
  whiteSpace: "nowrap",
};

const acceptBtn: CSSProperties = {
  ...btnBase,
  background: "var(--primary, #ff7a3a)",
  color: "var(--primary-ink, #1a1814)",
};

const declineBtn: CSSProperties = {
  ...btnBase,
  background: "transparent",
  color: "var(--ink, #f0eee5)",
  borderColor: "var(--line-strong, rgba(240,238,229,0.22))",
};
