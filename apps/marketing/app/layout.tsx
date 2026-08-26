import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { CookieConsent } from "./_components/CookieConsent";
import { PostHogProvider } from "./providers";
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

const HOME_TITLE = "Axel — Capture webhooks and deliver them to your data stack";
const HOME_DESCRIPTION =
  "Store original webhook payloads before returning 202, then deliver them to databases, warehouses, object storage, or HTTP endpoints with retries and replay controls.";

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
      <head>
        <script
          defer
          src="https://cloud.umami.is/script.js"
          data-website-id="3ffadf69-74e3-4847-8c26-dad6ed88bea8"
        />
        <script async src="https://www.googletagmanager.com/gtag/js?id=AW-18345689842" />
        <script
          dangerouslySetInnerHTML={{
            __html: `
              window.dataLayer = window.dataLayer || [];
              function gtag(){dataLayer.push(arguments);}
              gtag('js', new Date());
              gtag('config', 'AW-18345689842');
            `,
          }}
        />
      </head>
      <body>
        <JsonLd data={[organizationLd(), websiteLd()]} />
        <PostHogProvider>{children}</PostHogProvider>
        <CookieConsent />
      </body>
    </html>
  );
}
