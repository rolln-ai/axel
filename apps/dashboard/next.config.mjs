import { withSentryConfig } from "@sentry/nextjs";
import { fileURLToPath } from "node:url";

// Match the server/edge runtime precedence. The selected value is injected as
// NEXT_PUBLIC_SENTRY_DSN below so all three runtimes report to one project even
// if a stale public spelling remains configured on the hosting provider.
const sentryDsn = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN;
const sentryEnvironment = process.env.SENTRY_ENVIRONMENT || process.env.VERCEL_ENV;
const sentryRelease = process.env.SENTRY_RELEASE || process.env.VERCEL_GIT_COMMIT_SHA;
const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN;
// Vercel's hosted build environment supplies both markers. Requiring CI keeps
// a locally pulled production `.env.local` from turning an ordinary build into
// an artifact upload (or requiring a sensitive build token on developer Macs).
const isVercelProductionBuild =
  process.env.VERCEL === "1" &&
  process.env.CI === "1" &&
  process.env.VERCEL_ENV === "production";
const uploadProductionSourceMaps = isVercelProductionBuild && Boolean(sentryAuthToken);

if (isVercelProductionBuild && !sentryAuthToken) {
  throw new Error(
    "SENTRY_AUTH_TOKEN is required for Vercel production builds so source maps cannot be deployed without being uploaded.",
  );
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  ...(process.env.AXEL_STANDALONE_BUILD === "1" ? {
    output: "standalone",
    outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
  } : {}),
  poweredByHeader: false,
  reactStrictMode: true,
  // A DSN is intentionally public. Reuse the existing server-side setting so
  // the browser SDK works without maintaining a second value in Vercel.
  env: {
    ...(sentryDsn ? { NEXT_PUBLIC_SENTRY_DSN: sentryDsn } : {}),
    ...(sentryEnvironment
      ? { NEXT_PUBLIC_SENTRY_ENVIRONMENT: sentryEnvironment }
      : {}),
    ...(sentryRelease ? { NEXT_PUBLIC_SENTRY_RELEASE: sentryRelease } : {}),
  },
  // Workspace TS packages use `.js` extension specifiers for ESM
  // compliance (resolved by tsc's "Bundler" moduleResolution). Next.js
  // / Turbopack needs them transpiled rather than bundled as-is, since
  // there are no compiled `.js` files in the source trees.
  transpilePackages: ["@axel/shared", "@axel/observability", "@axel/pull-connectors"],
  // The authenticated app includes one-shot credentials in a few URL query
  // strings. Never forward the current page URL as a Referer.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
      },
    ];
  },
  // Legacy redirect: Event Maps was renamed to Data Contracts. Bookmarks
  // and shared links to /event-maps/* should land on the new
  // /data-contracts/* path without a manual lookup.
  async redirects() {
    return [
      {
        source: "/event-maps",
        destination: "/data-contracts",
        permanent: true,
      },
      {
        source: "/event-maps/:path*",
        destination: "/data-contracts/:path*",
        permanent: true,
      },
    ];
  },
};

export const sentryBuildOptions = {
  // These public slugs match the project receiving the dashboard's SENTRY_DSN.
  // Environment variables allow an intentional project move without a code
  // change, while keeping production uploads configured by default.
  org: process.env.SENTRY_ORG || "rolln",
  project: process.env.SENTRY_PROJECT || "javascript",
  ...(uploadProductionSourceMaps ? { authToken: sentryAuthToken } : {}),
  silent: !process.env.CI,
  widenClientFileUpload: true,
  // Next 16 builds with Turbopack. Its post-compile hook injects debug IDs and
  // uploads both client and server artifacts. Preview/local builds should not
  // create production artifacts or consume the upload token.
  useRunAfterProductionCompileHook: true,
  sourcemaps: {
    disable: !uploadProductionSourceMaps,
    deleteSourcemapsAfterUpload: true,
  },
  release: {
    name: sentryRelease,
    create: uploadProductionSourceMaps,
    finalize: uploadProductionSourceMaps,
  },
};

export default withSentryConfig(nextConfig, sentryBuildOptions);
