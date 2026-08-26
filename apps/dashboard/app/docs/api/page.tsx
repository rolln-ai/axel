import type { Metadata } from "next";
import { ApiReference } from "./ApiReference";

export const metadata: Metadata = {
  title: "API reference · Axel",
  description: "REST API and ingest endpoint reference for the Axel webhook platform.",
};

export default function ApiDocsPage() {
  return <ApiReference />;
}
