"use client";

import { useEffect } from "react";

declare global {
  interface Window {
    gtag?: (
      command: "event",
      eventName: "conversion",
      parameters: {
        send_to: string;
        value: number;
        currency: string;
        transaction_id: string;
      },
    ) => void;
  }
}

const COOKIE_NAME = "axel_signup_conversion";

export function SignupConversionTracker() {
  useEffect(() => {
    const hasMarker = document.cookie
      .split(";")
      .some((part) => part.trim() === `${COOKIE_NAME}=1`);
    if (!hasMarker || typeof window.gtag !== "function") return;

    window.gtag("event", "conversion", {
      send_to: "AW-18345689842/GM99CJqmz9UcEPKF9KtE",
      value: 1.0,
      currency: "USD",
      transaction_id: "",
    });
    // biome-ignore lint/suspicious/noDocumentCookie: Cookie Store API lacks broad browser support; plain cookie clear is intentional
    document.cookie = `${COOKIE_NAME}=; Max-Age=0; Path=/; SameSite=Lax`;
  }, []);

  return null;
}
