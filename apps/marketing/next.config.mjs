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
};

export default nextConfig;
