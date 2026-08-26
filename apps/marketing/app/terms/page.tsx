import type { Metadata } from "next";
import { LegalDoc } from "../_components/LegalDoc";
import { getLegalDoc } from "../../lib/legal";
import { pageMetadata } from "../../lib/seo";

export function generateMetadata(): Metadata {
  const doc = getLegalDoc("terms");
  return pageMetadata({
    title: doc?.meta.title ?? "Terms of Service",
    description: doc?.meta.summary ?? "The terms that govern your use of Axel.",
    path: "/terms",
  });
}

export default function Page() {
  return <LegalDoc slug="terms" />;
}
