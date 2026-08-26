// Iterative JSON depth probe over raw bytes. Returns true as soon as nesting
// exceeds `max`, so a 20k-deep hostile body short-circuits at byte ~max+1
// instead of forcing JSON.parse to recurse the host stack. UTF-8 multibyte
// continuation bytes all have the high bit set, so they cannot collide with
// the ASCII bracket/quote/escape codes we scan for.
export function exceedsJsonDepth(bytes: Uint8Array, max: number): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (c === 0x5c /* \ */) {
        escaped = true;
      } else if (c === 0x22 /* " */) {
        inString = false;
      }
      continue;
    }
    if (c === 0x22 /* " */) {
      inString = true;
      continue;
    }
    if (c === 0x7b /* { */ || c === 0x5b /* [ */) {
      depth++;
      if (depth > max) return true;
    } else if (c === 0x7d /* } */ || c === 0x5d /* ] */) {
      if (depth > 0) depth--;
    }
  }
  return false;
}

export function looksLikeJson(contentType: string | null): boolean {
  if (!contentType) return false;
  const lower = contentType.toLowerCase();
  return lower.includes("application/json") || lower.endsWith("+json");
}
