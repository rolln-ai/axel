import type { Metadata } from "next";
import { LegalDoc } from "../_components/LegalDoc";
import { getLegalDoc } from "../../lib/legal";
import { pageMetadata } from "../../lib/seo";

export function generateMetadata(): Metadata {
  const doc = getLegalDoc("privacy");
  return pageMetadata({
    title: doc?.meta.title ?? "Privacy Policy",
    description: doc?.meta.summary ?? "How Axel collects, uses, and protects your data.",
    path: "/privacy",
  });
}

export default function Page() {
  return <LegalDoc slug="privacy" />;
}
