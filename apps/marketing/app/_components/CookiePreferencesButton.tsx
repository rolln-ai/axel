"use client";

import { CONSENT_PREFERENCES_EVENT } from "../../lib/consent";

/**
 * Footer control to re-open the cookie-consent banner so a visitor can change
 * or withdraw their analytics choice at any time (Cookie Policy, Section 6).
 */
export function CookiePreferencesButton() {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event(CONSENT_PREFERENCES_EVENT))}
      style={{
        background: "none",
        border: 0,
        padding: 0,
        margin: 0,
        font: "inherit",
        color: "inherit",
        cursor: "pointer",
      }}
    >
      Cookie preferences
    </button>
  );
}
