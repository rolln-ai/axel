export class ResponseBodyTooLargeError extends Error {
  constructor() {
    super("upstream_response_body_too_large");
    this.name = "ResponseBodyTooLargeError";
  }
}

export async function readResponseTextLimited(
  response: Response,
  maxBytes: number,
): Promise<string> {
  return new TextDecoder().decode(await readResponseBytesLimited(response, maxBytes));
}

export async function readResponseBytesLimited(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const declaredBytes = Number(declared);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new ResponseBodyTooLargeError();
    }
  }

  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseBodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
