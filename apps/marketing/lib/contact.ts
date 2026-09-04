const configuredSupportEmail = process.env.NEXT_PUBLIC_SUPPORT_EMAIL?.trim() ?? "";

if (
  configuredSupportEmail &&
  !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(configuredSupportEmail)
) {
  throw new Error("NEXT_PUBLIC_SUPPORT_EMAIL must be a valid email address");
}

export const SUPPORT_EMAIL = configuredSupportEmail;
export const SUPPORT_HREF = SUPPORT_EMAIL ? `mailto:${SUPPORT_EMAIL}` : null;
export const COMMUNITY_SUPPORT_URL = "https://github.com/rolln-ai/axel/discussions";
