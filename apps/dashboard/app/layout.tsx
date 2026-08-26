import type { Metadata } from "next";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { CookieConsent } from "./_components/CookieConsent";
import { PostHogProvider } from "./providers";

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
      <body className="antialiased">
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
