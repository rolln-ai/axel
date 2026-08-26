import type { Metadata } from "next";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { CookieConsent } from "./_components/CookieConsent";
import { PostHogProvider } from "./providers";
import { SignupConversionTracker } from "./_components/SignupConversionTracker";

export const metadata: Metadata = {
  title: "Axel · Dashboard",
  description:
    "Operate webhook sources, routes, deliveries, and sync health from Axel.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
    >
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
      <body className="antialiased">
        <SignupConversionTracker />
        <PostHogProvider>
          <ThemeProvider
            attribute="class"
            defaultTheme="dark"
            enableSystem
            disableTransitionOnChange
          >
            <TooltipProvider>{children}</TooltipProvider>
            <Toaster />
            <CookieConsent />
          </ThemeProvider>
        </PostHogProvider>
      </body>
    </html>
  );
}
