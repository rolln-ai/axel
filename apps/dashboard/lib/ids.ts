import { randomBytes } from "node:crypto";

export function prefixedId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("base64url")}`;
}

export function slugifyWorkspaceName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "workspace";
}
