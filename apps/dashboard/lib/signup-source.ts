export const SIGNUP_SOURCES = ["github", "website", "unknown"] as const;
export type SignupSource = (typeof SIGNUP_SOURCES)[number];

/** Store a link label only. Never retain a referral URL or arbitrary query text. */
export function signupSource(value: unknown): SignupSource {
  return value === "github" || value === "website" ? value : "unknown";
}
