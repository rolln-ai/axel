import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { SITE_NAME, SITE_URL, TWITTER_HANDLE } from "../lib/seo";
import { organizationLd, websiteLd } from "../lib/structured-data";
import { JsonLd } from "./_components/JsonLd";

const sans = Geist({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
});

const mono = Geist_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-mono",
});

const HOME_TITLE = "Axel — Open-source webhook delivery. Managed in the cloud.";
const HOME_DESCRIPTION =
  "Open-source webhook ingestion, routing, retries, and replay under Apache-2.0. Self-host Axel or start free on Axel Cloud with managed infrastructure and searchable delivery history.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: HOME_TITLE,
    // Child routes export a bare title (e.g. "Pricing"); the template brands it.
    template: `%s — ${SITE_NAME}`,
  },
  description: HOME_DESCRIPTION,
  applicationName: SITE_NAME,
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: SITE_NAME,
    title: HOME_TITLE,
    description: HOME_DESCRIPTION,
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    site: TWITTER_HANDLE,
    creator: TWITTER_HANDLE,
    title: HOME_TITLE,
    description: HOME_DESCRIPTION,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, "max-image-preview": "large", "max-snippet": -1 },
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <JsonLd data={[organizationLd(), websiteLd()]} />
        {children}
      </body>
    </html>
  );
}
