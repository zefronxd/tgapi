/**
 * HTTP response helpers and CORS configuration
 */

import { brotliCompressSync, gzipSync } from "node:zlib";

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

export function error(message: string, status = 400): Response {
  return json({ error: message }, status);
}

type ContentEncoding = "br" | "gzip";

const COMPRESSIBLE_CONTENT_TYPES = [
  "application/json",
  "application/javascript",
  "application/x-javascript",
  "application/xml",
  "image/svg+xml",
];

function qualityForEncoding(acceptEncoding: string, encoding: ContentEncoding): number {
  let wildcardQuality: number | undefined;

  for (const part of acceptEncoding.toLowerCase().split(",")) {
    const [rawName, ...parameters] = part.trim().split(";");
    const name = rawName.trim();
    const qualityParameter = parameters.find((parameter) => parameter.trim().startsWith("q="));
    const parsedQuality = qualityParameter ? Number(qualityParameter.trim().slice(2)) : 1;
    const quality = Number.isFinite(parsedQuality) ? Math.max(0, Math.min(1, parsedQuality)) : 0;

    if (name === encoding) return quality;
    if (name === "*") wildcardQuality = quality;
  }

  return wildcardQuality ?? 0;
}

function preferredEncodings(request: Request): ContentEncoding[] {
  const acceptEncoding = request.headers.get("Accept-Encoding");
  if (!acceptEncoding) return [];

  return (["br", "gzip"] as ContentEncoding[])
    .map((encoding, index) => ({ encoding, quality: qualityForEncoding(acceptEncoding, encoding), index }))
    .filter(({ quality }) => quality > 0)
    .sort((a, b) => b.quality - a.quality || a.index - b.index)
    .map(({ encoding }) => encoding);
}

function isCompressible(response: Response): boolean {
  if (!response.body || response.status === 204 || response.status === 304) return false;
  if (response.headers.has("Content-Encoding")) return false;

  const contentType = response.headers.get("Content-Type")?.toLowerCase() || "";
  return contentType.startsWith("text/") ||
    COMPRESSIBLE_CONTENT_TYPES.some((type) => contentType.startsWith(type));
}

function addVaryAcceptEncoding(headers: Headers): void {
  const vary = headers.get("Vary");
  if (vary === "*") return;
  if (!vary) {
    headers.set("Vary", "Accept-Encoding");
  } else if (!vary.toLowerCase().split(",").some((value) => value.trim() === "accept-encoding")) {
    headers.set("Vary", `${vary}, Accept-Encoding`);
  }
}

function encode(body: Uint8Array, encoding: ContentEncoding): Uint8Array {
  if (encoding === "br") return new Uint8Array(brotliCompressSync(body));
  return new Uint8Array(gzipSync(body));
}

/**
 * Compress text responses according to the client's Accept-Encoding header.
 *
 * Brotli is preferred for modern clients, gzip is the fallback, and clients
 * without either encoding receive the original response. Media responses are
 * intentionally left untouched because audio and images are already encoded.
 */
export async function compressResponse(request: Request, response: Response): Promise<Response> {
  if (!isCompressible(response)) return response;

  const headers = new Headers(response.headers);
  addVaryAcceptEncoding(headers);
  const encodings = preferredEncodings(request);
  if (!encodings.length) {
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  const body = new Uint8Array(await response.arrayBuffer());
  if (body.byteLength < 256) {
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  for (const encoding of encodings) {
    try {
      const compressedBody = encode(body, encoding);
      headers.set("Content-Encoding", encoding);
      headers.delete("Content-Length");
      const compressedBuffer = new ArrayBuffer(compressedBody.byteLength);
      new Uint8Array(compressedBuffer).set(compressedBody);

      return new Response(compressedBuffer, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch (error) {
      console.warn(`Unable to encode response as ${encoding}:`, error);
    }
  }

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
