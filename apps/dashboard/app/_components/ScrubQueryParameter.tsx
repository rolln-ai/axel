"use client";

import { useEffect } from "react";

/** Remove a secret query parameter after its value has reached component props. */
export function ScrubQueryParameter({ name }: { name: string }) {
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has(name)) return;
    url.searchParams.delete(name);
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }, [name]);

  return null;
}
