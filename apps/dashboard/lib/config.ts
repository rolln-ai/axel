import "server-only";

export function getSetupProblem(): string | null {
  if (!process.env.DATABASE_URL) return "DATABASE_URL is not configured.";
  return null;
}
