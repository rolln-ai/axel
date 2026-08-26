/**
 * Encode an R2 object key for Cloudflare's account-scoped REST path.
 *
 * Cloudflare requires `/` inside `object_key` to remain literal. Encoding the
 * whole key with encodeURIComponent changes those separators to `%2F` and
 * addresses a different, usually missing object. Encode each segment instead.
 */
export function encodeCloudflareR2ObjectKey(key: string): string {
  return key.split("/").map((segment) => {
    // WHATWG URL parsing normalizes literal and percent-encoded dot segments,
    // which could escape `/objects/`. Axel does not generate these keys; reject
    // corrupted or operator-supplied ones rather than call another API path.
    if (segment === "." || segment === "..") {
      throw new Error("invalid_r2_object_key: dot path segments are not supported");
    }
    return encodeURIComponent(segment);
  }).join("/");
}

export function cloudflareR2ObjectUrl(
  accountId: string,
  bucket: string,
  key: string,
): string {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/r2/buckets/${encodeURIComponent(bucket)}/objects/${encodeCloudflareR2ObjectKey(key)}`;
}
