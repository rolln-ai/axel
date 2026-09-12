"use client";

import Link, { useLinkStatus } from "next/link";
import { useState, type ComponentProps } from "react";
import { createPortal } from "react-dom";
import { NavigationProgress } from "./NavigationProgress";

/** Keep native Link behavior, show pending navigation, and prefetch on intent. */
export default function NavigationLink({ children, prefetch, onMouseEnter, onFocus, ...props }: ComponentProps<typeof Link>) {
  const [intent, setIntent] = useState(false);
  return (
    <Link
      {...props}
      prefetch={prefetch === undefined ? (intent ? null : false) : prefetch}
      onMouseEnter={(event) => { setIntent(true); onMouseEnter?.(event); }}
      onFocus={(event) => { setIntent(true); onFocus?.(event); }}
    >
      {children}
      <LinkProgress />
    </Link>
  );
}

function LinkProgress() {
  const { pending } = useLinkStatus();
  return pending ? createPortal(<NavigationProgress />, document.body) : null;
}
