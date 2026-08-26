import type { Metadata } from "next";
import { LegalDoc } from "../_components/LegalDoc";
import { getLegalDoc } from "../../lib/legal";
import { pageMetadata } from "../../lib/seo";

export function generateMetadata(): Metadata {
  const doc = getLegalDoc("acceptable-use");
  return pageMetadata({
    title: doc?.meta.title ?? "Acceptable Use Policy",
    description: doc?.meta.summary ?? "What you can and can't do with Axel.",
    path: "/acceptable-use",
  });
}

export default function Page() {
  return <LegalDoc slug="acceptable-use" />;
}
