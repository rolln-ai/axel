/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // The OG card reads Geist off disk at request time, because Satori needs font
  // bytes and cannot use next/font. Name the directory so the files are bundled
  // with the function rather than left behind at deploy.
  outputFileTracingIncludes: {
    "/opengraph-image": ["./app/_fonts/**"],
  },
  // Reverse proxy for PostHog. The browser talks to same-origin `/ingest/*`,
  // which we forward to PostHog US, so analytics keeps working behind ad
  // blockers that block posthog.com directly. Order matters — the catch-all
  // must stay last. See https://posthog.com/docs/advanced/proxy/nextjs.
  async rewrites() {
    return [
      {
        source: "/ingest/static/:path*",
        destination: "https://us-assets.i.posthog.com/static/:path*",
      },
      {
        source: "/ingest/array/:path*",
        destination: "https://us-assets.i.posthog.com/array/:path*",
      },
      {
        source: "/ingest/:path*",
        destination: "https://us.i.posthog.com/:path*",
      },
    ];
  },
  // Let the proxy forward `/ingest/decide` etc. without a trailing-slash
  // redirect first.
  skipTrailingSlashRedirect: true,
};

export default nextConfig;
