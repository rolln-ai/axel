import type { Metadata } from "next";
import { LegalDoc } from "../_components/LegalDoc";
import { getLegalDoc } from "../../lib/legal";
import { pageMetadata } from "../../lib/seo";

export function generateMetadata(): Metadata {
  const doc = getLegalDoc("cookies");
  return pageMetadata({
    title: doc?.meta.title ?? "Cookie Policy",
    description: doc?.meta.summary ?? "How Axel uses cookies and similar technologies.",
    path: "/cookies",
  });
}

export default function Page() {
  return <LegalDoc slug="cookies" />;
}
