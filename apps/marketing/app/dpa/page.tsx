import type { Metadata } from "next";
import { LegalDoc } from "../_components/LegalDoc";
import { getLegalDoc } from "../../lib/legal";
import { pageMetadata } from "../../lib/seo";

export function generateMetadata(): Metadata {
  const doc = getLegalDoc("dpa");
  return pageMetadata({
    title: doc?.meta.title ?? "Data Processing Addendum",
    description: doc?.meta.summary ?? "Axel's Data Processing Addendum for customers processing personal data.",
    path: "/dpa",
  });
}

export default function Page() {
  return <LegalDoc slug="dpa" />;
}
