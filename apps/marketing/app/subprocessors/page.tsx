import type { Metadata } from "next";
import { LegalDoc } from "../_components/LegalDoc";
import { getLegalDoc } from "../../lib/legal";
import { pageMetadata } from "../../lib/seo";

export function generateMetadata(): Metadata {
  const doc = getLegalDoc("subprocessors");
  return pageMetadata({
    title: doc?.meta.title ?? "Sub-processors",
    description: doc?.meta.summary ?? "The third-party sub-processors Axel uses to deliver the service.",
    path: "/subprocessors",
  });
}

export default function Page() {
  return <LegalDoc slug="subprocessors" />;
}
