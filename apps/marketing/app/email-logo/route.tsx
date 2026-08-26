import { ImageResponse } from "next/og";
import { AxelMark } from "../../lib/logo-mark";

/**
 * Hosted PNG of the Axel mark for transactional emails.
 *
 * Email clients strip inline <svg> (Gmail) and rasterize unpredictably
 * (Outlook), so emails can't reuse the app's SVG <Logo> directly — they
 * reference this rasterized PNG with a plain <img src>. Served at /email-logo
 * and consumed by apps/dashboard/lib/email-layout.ts via emailLogoUrl(),
 * which versions the URL (?v=N) because this response is cached immutable.
 */

const SIZE = 120; // 2x of the ~26–60px display sizes used in email headers

export function GET() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <AxelMark size={SIZE} />
      </div>
    ),
    {
      width: SIZE,
      height: SIZE,
      headers: {
        "Cache-Control": "public, max-age=86400, s-maxage=604800, immutable",
      },
    },
  );
}
