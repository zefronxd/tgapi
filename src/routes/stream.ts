/**
 * Stream Routes
 * /api/stream, /api/download, /api/proxy, /api/music/find
 */

import { json, error, corsHeaders } from "../helpers/response.ts";
import {
  fetchFromPiped,
  fetchFromInvidious,
  fetchFromYtDlp,
  downloadWithYtDlp,
  fetchFromMp3Fallback,
  getCachedFastAudio,
  prepareM4aSource,
  prepareFastAudio,
  getCachedMp3Audio,
  prepareMp3Audio,
  ensureMp3Cached,
  transcodeToSmallMp3,
  openPreparedAudio,
  fetchAudioResponseWithHeaderTimeout,
} from "../services/streaming.ts";
import { fetchFromInnerTube } from "../services/innertube.ts";
import type { YTMusic } from "../services/ytmusic.ts";
import {
  cacheAudioOnGoogleDrive,
  getCachedAudio,
  refreshCachedAudioUrl,
} from "../services/audio-cache.ts";

const SOURCE_TIMEOUT_MS = 5000;
const MEDIA_SOURCE_TIMEOUT_MS = Math.max(
  10_000,
  Number(Deno.env.get("MEDIA_SOURCE_TIMEOUT_MS") || 60_000),
);
const MEDIUM_BITRATE = 128_000;
// Some videos need a provider-side conversion job before an audio URL exists.
// Give the resolver enough time to finish instead of returning the old
// three-second "source unavailable" error while a fallback is still working.
const DOWNLOAD_DEADLINE_MS = 60_000;
// A persisted cache hit must not hang for the full media-source timeout. If
// Telegram/Drive cannot serve the cached bytes promptly, return a cache error
// instead of silently falling back to YouTube resolution and FFmpeg.
const CACHED_AUDIO_TIMEOUT_MS = Math.max(
  3_000,
  Number(Deno.env.get("CACHED_AUDIO_TIMEOUT_MS") || 10_000),
);
const FAST_MP3_CACHE_TTL_MS = Math.max(
  30_000,
  Number(Deno.env.get("FAST_MP3_CACHE_TTL_MS") || 30 * 60_000),
);
const FAST_MP3_CACHE_MAX_BYTES = Math.max(
  8 * 1024 * 1024,
  Number(Deno.env.get("FAST_MP3_CACHE_MAX_MB") || 64) * 1024 * 1024,
);

type FastMp3CacheEntry = {
  bytes: Uint8Array;
  title: string;
  contentType: string;
  expiresAt: number;
  lastUsedAt: number;
};

// Once a persisted Telegram cache has been read once, keep the small MP3 in
// process memory. Repeat requests can then return without PostgreSQL, the
// Telegram getFile call, or a Telegram CDN round trip.
const fastMp3Cache = new Map<string, FastMp3CacheEntry>();
let fastMp3CacheBytes = 0;

function getFastMp3Cache(id: string): FastMp3CacheEntry | null {
  const entry = fastMp3Cache.get(id);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    fastMp3Cache.delete(id);
    fastMp3CacheBytes -= entry.bytes.byteLength;
    return null;
  }
  entry.lastUsedAt = Date.now();
  return entry;
}

function rememberFastMp3Cache(
  id: string,
  bytes: Uint8Array,
  title: string,
  contentType: string,
): void {
  if (!bytes.byteLength || bytes.byteLength > FAST_MP3_CACHE_MAX_BYTES) return;

  const previous = fastMp3Cache.get(id);
  if (previous) fastMp3CacheBytes -= previous.bytes.byteLength;

  fastMp3Cache.set(id, {
    bytes,
    title,
    contentType,
    expiresAt: Date.now() + FAST_MP3_CACHE_TTL_MS,
    lastUsedAt: Date.now(),
  });
  fastMp3CacheBytes += bytes.byteLength;

  while (fastMp3CacheBytes > FAST_MP3_CACHE_MAX_BYTES && fastMp3Cache.size > 1) {
    const oldest = [...fastMp3Cache.entries()]
      .sort(([, a], [, b]) => a.lastUsedAt - b.lastUsedAt)[0];
    if (!oldest) break;
    fastMp3Cache.delete(oldest[0]);
    fastMp3CacheBytes -= oldest[1].bytes.byteLength;
  }
}

async function warmFastMp3Cache(
  id: string,
  response: Response,
  title: string,
  contentType: string,
): Promise<void> {
  try {
    const bytes = new Uint8Array(await response.arrayBuffer());
    rememberFastMp3Cache(id, bytes, title, contentType);
  } catch {
    // The original response remains authoritative; RAM warming is optional.
  }
}

export async function handleStream(searchParams: URLSearchParams): Promise<Response> {
  const id = searchParams.get("id");
  if (!id) return error("Missing id");

  const cachedMp3 = await getCachedAudio(id, "mp3", false);
  if (cachedMp3) {
    return json({
      success: true,
      service: "telegram-cache",
      streamingUrls: [{
        url: `/api/download?id=${encodeURIComponent(id)}&format=mp3`,
        mimeType: "audio/mpeg",
        bitrate: 64_000,
      }],
      metadata: {
        id,
        title: cachedMp3.title,
        contentType: cachedMp3.contentType,
      },
      downloadUrl: `/api/download?id=${encodeURIComponent(id)}&format=mp3`,
      requestedId: id,
      timestamp: new Date().toISOString(),
    });
  }

  const providerRequests = [fetchFromPiped(id), fetchFromInvidious(id)].map(
    async (request) => {
      const provider = await request;
      if (!provider.success) throw new Error("Provider has no stream");
      return provider;
    },
  );
  try {
    const provider: any = await Promise.any(providerRequests);
    return json({
      success: true,
      service: "hlsUrl" in provider ? "piped" : "invidious",
      instance: provider.instance,
      streamingUrls: provider.streamingUrls,
      metadata: provider.metadata,
      downloadUrl: `/api/download?id=${encodeURIComponent(id)}&format=mp3`,
      requestedId: id,
      timestamp: new Date().toISOString(),
    });
  } catch {
    return json({ success: false, error: "No streaming data found" }, 404);
  }
}

function audioHeaders(req: Request): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "*/*",
    "Referer": "https://www.youtube.com/",
    "Origin": "https://www.youtube.com",
  };
  const rangeHeader = req.headers.get("Range");
  if (rangeHeader) headers["Range"] = rangeHeader;
  return headers;
}

function safeFilename(value: string): string {
  const cleaned = value
    .replace(/[\/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  return cleaned || "audio";
}

function extensionForContentType(contentType: string): string {
  if (contentType.includes("mpeg") || contentType.includes("mp3")) return ".mp3";
  if (contentType.includes("webm")) return ".webm";
  if (contentType.includes("ogg")) return ".ogg";
  if (contentType.includes("wav")) return ".wav";
  return ".m4a";
}

function removeAudioExtension(value: string): string {
  return value.replace(/\.(mp3|m4a|mp4|webm|ogg|wav|opus)$/i, "");
}

function videoIdFromInput(value: string): string | null {
  const input = value.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(input)) return input;

  try {
    const url = new URL(input);
    if (url.hostname === "youtu.be") {
      const id = url.pathname.slice(1).split("/")[0];
      return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
    }
    if (url.hostname.endsWith("youtube.com")) {
      const id = url.searchParams.get("v") || url.pathname.match(/\/(?:shorts|embed|live)\/([^/?]+)/)?.[1];
      return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
    }
  } catch {
    // Treat malformed URL-like input as an invalid video ID below.
  }
  return null;
}

function isPrivateProxyHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "ip6-localhost" ||
    host === "0.0.0.0" ||
    host === "::" ||
    host === "::1" ||
    host.endsWith(".local")
  ) {
    return true;
  }

  // Block literal loopback, link-local, private, and carrier-grade NAT IPv4
  // destinations. Hostnames still need to be public; this prevents the common
  // /api/proxy?url=http://127.0.0.1/... SSRF case.
  const octets = host.split(".");
  if (octets.length === 4 && octets.every((part) => /^\d+$/.test(part))) {
    const values = octets.map(Number);
    if (values.some((value) => value < 0 || value > 255)) return true;
    const [a, b] = values;
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }

  // Reject IPv6 literals. This is stricter than trying to enumerate every
  // IPv6-mapped private range and keeps the public proxy from becoming an
  // alternate path to internal services.
  return host.includes(":");
}

function mediumAudioStreams(streams: any[]): any[] {
  const valid = streams.filter((stream) => stream?.url || stream?.directUrl);
  if (!valid.length) return [];

  // Prefer a stream close to 128 kbps, but never choose a larger stream when
  // a medium-quality option is available. This avoids needlessly moving the
  // old high-quality source through the proxy and encoder.
  const medium = valid.filter((stream) => Number(stream.bitrate || 0) <= 160_000);
  return (medium.length ? medium : valid)
    .slice()
    .sort((a, b) => Math.abs(Number(a.bitrate || 0) - MEDIUM_BITRATE) -
      Math.abs(Number(b.bitrate || 0) - MEDIUM_BITRATE));
}

async function fetchFirstAudioSource(
  streams: any[],
  req: Request,
  timeoutMs = SOURCE_TIMEOUT_MS,
): Promise<Response | null> {
  const candidates = mediumAudioStreams(streams).slice(0, 3);
  if (!candidates.length) return null;

  const sourceUrls = candidates.flatMap((stream) =>
    [stream.url, stream.directUrl].filter((url, index, urls) => url && urls.indexOf(url) === index)
  );
  const requests = sourceUrls.map((sourceUrl) => (async () => {
    const response = await fetchAudioResponseWithHeaderTimeout(
      sourceUrl,
      { headers: audioHeaders(req) },
      Math.max(1, Math.min(MEDIA_SOURCE_TIMEOUT_MS, timeoutMs)),
    );
    if (!response.ok && response.status !== 206) {
      await response.body?.cancel();
      throw new Error(`Audio source returned ${response.status}`);
    }
    const contentType = (response.headers.get("Content-Type") || "").toLowerCase();
    if (
      contentType.includes("mpegurl") ||
      contentType.includes("hls") ||
      /\.m3u8(?:$|[?#])/i.test(sourceUrl)
    ) {
      await response.body?.cancel();
      throw new Error("Audio source returned an HLS playlist");
    }

    // Some relays mislabel an HLS playlist as audio/mpeg. Probe a clone
    // without consuming the response that will be returned to the caller.
    const probeReader = response.clone().body?.getReader();
    if (probeReader) {
      const probe = await probeReader.read();
      await probeReader.cancel();
      const prefix = new TextDecoder().decode(probe.value?.slice(0, 64) || new Uint8Array());
      if (prefix.trimStart().startsWith("#EXTM3U")) {
        await response.body?.cancel();
        throw new Error("Audio source returned an HLS playlist");
      }
    }
    return response;
  })());

  try {
    return await Promise.any(requests);
  } catch {
    return null;
  }
}

async function findDownloadSource(
  id: string,
  req: Request,
  allowMp3Fallback: boolean,
  deadlineAt = Date.now() + DOWNLOAD_DEADLINE_MS,
): Promise<{ response: Response; title: string; alreadyMp3?: boolean; deadline: number } | null> {
  const excludedInstances = new Set<string>();
  const deadline = deadlineAt;

  // Provider lookup is parallel inside fetchFromPiped/fetchFromInvidious.
  // Keep a second pass for IP-bound relay failures, but cap it tightly so a
  // dead public instance cannot make a download wait tens of seconds.
  for (let attempt = 0; attempt < 2; attempt++) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return null;
    // Resolve both provider families at the same time. A slow/dead Piped
    // instance must not delay an otherwise healthy Invidious result.
    const [piped, invidious, ytDlp] = await Promise.all([
      fetchFromPiped(id, excludedInstances, remainingMs),
      fetchFromInvidious(id, excludedInstances, remainingMs),
      fetchFromYtDlp(id, remainingMs),
    ]);
    const providers = [piped, invidious, ytDlp].filter((provider) => provider.success);

    // Also race the actual media requests: metadata can be healthy while one
    // provider's relay is not reachable from this server.
    const sourceAttempts = providers.map((provider: any) => (async () => {
      const response = await fetchFirstAudioSource(provider.streamingUrls, req, deadline - Date.now());
      if (!response) throw new Error("No usable media source");
      return { response, title: provider.metadata?.title || "", deadline };
    })());
    try {
      return await Promise.any(sourceAttempts);
    } catch {
      for (const provider of providers) excludedInstances.add(provider.instance);
    }

    if (!piped.success && !invidious.success && !ytDlp.success) break;
  }

  const directDownload = await downloadWithYtDlp(id, Math.max(1, deadline - Date.now()));
  if (directDownload) {
    return { ...directDownload, deadline };
  }

  if (allowMp3Fallback && deadline > Date.now()) {
    const fallback = await fetchFromMp3Fallback(id, deadline - Date.now());
    if (fallback.success) {
      const response = await fetchAudioResponseWithHeaderTimeout(
        fallback.url,
        { headers: { "User-Agent": "Mozilla/5.0", "Accept": "*/*" } },
        Math.max(1, deadline - Date.now()),
      );
      if (response.ok) {
        return { response, title: fallback.title, alreadyMp3: true, deadline };
      }
      await response.body?.cancel();
    }
  }

  return null;
}

/**
 * Resolve a fresh InnerTube audio URL and proxy it as a browser download.
 * Every request gets a current signed media URL; nothing is persisted locally.
 */
export async function handleDownload(searchParams: URLSearchParams, req: Request): Promise<Response> {
  const rawInput = searchParams.get("id") || searchParams.get("url");
  if (!rawInput) return error("Missing id or url");
  const id = videoIdFromInput(rawInput);
  if (!id) return error("Invalid YouTube video ID or URL");
  const requestStartedAt = Date.now();
  const downloadDeadline = requestStartedAt + DOWNLOAD_DEADLINE_MS;
  // Downloads are MP3-first. The browser does not need to know whether the
  // first request was converted or served from the persistent cache.
  const format = (searchParams.get("format") || "mp3").toLowerCase();
  if (format !== "mp3" && format !== "original") {
    return error("Unsupported format. Use mp3 or original");
  }

  try {
    const requestedFilename = removeAudioExtension(searchParams.get("filename") || `audio-${id}`);
    let response: Response | null = null;
    let title = "";
    let responseIsMp3 = false;
    // A persisted cache row can outlive its Telegram/Drive object or URL.
    // Keep the request alive by rebuilding the audio, then replace the stale
    // record in the background instead of returning a cache-only 503.
    let repairCachedMp3 = false;

    // Fast audio path: use a prepared M4A without starting FFmpeg. This is
    // substantially faster than generating an MP3 and is still a browser-
    // compatible audio download.
    if (format === "original") {
      const cachedAudio = getCachedFastAudio(id);
      if (cachedAudio?.success) {
        response = await openPreparedAudio(cachedAudio);
        title = cachedAudio.title;
      } else {
        const storedAudio = await getCachedAudio(id);
        if (storedAudio) {
          const cachedResponse = await fetchCachedAudio(storedAudio, req);
          if (cachedResponse) {
            return createDownloadResponse(
              cachedResponse,
              requestedFilename,
              storedAudio.title,
              storedAudio.contentType || "audio/mp4",
            );
          }
        } else {
          const audio = await prepareM4aSource(id, 30_000);
          if (!audio.success) {
            // Fall through to the existing authenticated/direct resolvers.
          } else {
            const directHandoff = searchParams.get("direct") !== "0";
            if (directHandoff) {
              // Start the final Google Drive/PostgreSQL cache in the background while the
              // browser downloads this first direct result.
              void prepareFastAudio(id, 30_000);
              return directAudioRedirect(audio.url, requestedFilename, audio.title || "");
            }
            const audioResponse = await fetchAudioResponseWithHeaderTimeout(
              audio.url,
              { headers: { "User-Agent": "Mozilla/5.0", "Accept": "audio/mp4,audio/*,*/*" } },
              20_000,
            );
            if (audioResponse.ok) {
              response = audioResponse;
              title = audio.title || "";
            } else {
              await audioResponse.body?.cancel();
            }
          }
        }
      }
    }

    // MP3 is persisted in Telegram after the first conversion. Subsequent
    // plays/downloads use the refreshed Telegram URL directly.
    if (format === "mp3") {
      const fastCachedMp3 = getFastMp3Cache(id);
      if (fastCachedMp3) {
        console.log(JSON.stringify({
          event: "download_cache",
          state: "memory_hit",
          videoId: id,
          size: fastCachedMp3.bytes.byteLength,
        }));
        return createDownloadResponse(
          createFastMp3Response(fastCachedMp3, req),
          requestedFilename,
          fastCachedMp3.title,
          fastCachedMp3.contentType || "audio/mpeg",
        );
      }

      // Check the durable cache before starting any resolver or FFmpeg work.
      // If the backing object is stale/unavailable, keep going through the
      // normal source resolution path. Returning a cache-only 503 here makes
      // one expired Telegram URL take the whole video offline indefinitely.
      // Resolve Telegram's short-lived file URL before the first media fetch.
      // The stable file_id remains in PostgreSQL; only the URL is refreshed.
      const cachedMp3 = await getCachedAudio(id, "mp3", true);
      if (cachedMp3) {
        let cachedResponse = await fetchCachedAudio(cachedMp3, req);
        let cachedRecord = cachedMp3;
        if (!cachedResponse && cachedMp3.provider === "telegram") {
          const refreshed = await refreshCachedAudioUrl(id, "mp3");
          if (refreshed) {
            cachedRecord = refreshed;
            cachedResponse = await fetchCachedAudio(refreshed, req);
          }
        }
        if (cachedResponse) {
          void warmFastMp3Cache(
            id,
            cachedResponse.clone(),
            cachedRecord.title,
            cachedRecord.contentType || "audio/mpeg",
          );
          console.log(JSON.stringify({
            event: "download_cache",
            state: "hit",
            videoId: id,
            provider: cachedRecord.provider,
          }));
          return createDownloadResponse(
            cachedResponse,
            requestedFilename,
            cachedRecord.title,
            cachedRecord.contentType || "audio/mpeg",
          );
        }

        console.warn(JSON.stringify({
          event: "download_cache",
          state: "unavailable",
          videoId: id,
          provider: cachedRecord.provider,
        }));
        repairCachedMp3 = true;
      }

      // If conversion has already completed but Telegram is still uploading,
      // serve the local MP3 immediately instead of waiting for the cache write.
      const preparedCachedMp3 = getCachedMp3Audio(id);
      if (preparedCachedMp3?.success) {
        response = await openPreparedAudio(preparedCachedMp3);
        title = preparedCachedMp3.title;
        responseIsMp3 = true;
        if (response && repairCachedMp3) {
          void cacheAudioOnGoogleDrive(id, preparedCachedMp3, true, "mp3");
        }
      } else {
        // No durable cache exists. Start the detached cache job only now, so
        // a cache hit can never compete with a new resolver/conversion job.
        void ensureMp3Cached(id, 45_000);
        const preparedMp3 = await prepareMp3Audio(
          id,
          Math.max(1, downloadDeadline - Date.now()),
        );
        if (preparedMp3.success) {
          response = await openPreparedAudio(preparedMp3);
          title = preparedMp3.title;
          responseIsMp3 = true;
          if (response && repairCachedMp3) {
            void cacheAudioOnGoogleDrive(id, preparedMp3, true, "mp3");
          }
        }
      }
    }

    if (!response) {
      const directSource = await fetchFromInnerTube(id, req);
      if (directSource) {
        response = directSource.response;
        title = directSource.title;
      } else {
        const fallbackSource = await findDownloadSource(
          id,
          req,
          format === "mp3",
          downloadDeadline,
        );
        if (!fallbackSource) {
          return json({
            success: false,
            error: "No authenticated audio source could be resolved",
          }, 504);
        }
        response = fallbackSource.response;
        title = fallbackSource.title;
      }
    }

    if (!response) {
      return json({
        success: false,
        error: "No audio source could be resolved",
      }, 504);
    }

    if (format === "mp3" && !responseIsMp3) {
      const smallMp3 = await transcodeToSmallMp3(
        response,
        title,
        Math.max(1, downloadDeadline - Date.now()),
      );
      if (!smallMp3.success) {
        await response.body?.cancel();
        return json({
          success: false,
          error: smallMp3.error,
        }, 502);
      }
      // The cache job is intentionally detached from the response lifecycle,
      // so cancelling a browser download does not cancel the upload.
      void cacheAudioOnGoogleDrive(id, smallMp3, repairCachedMp3, "mp3");
      response = await openPreparedAudio(smallMp3);
      if (!response) return json({ success: false, error: "MP3 output file unavailable" }, 502);
      title = smallMp3.title || title;
      responseIsMp3 = true;
    }

    return createDownloadResponse(response, requestedFilename, title);
  } catch (err) {
    return new Response("Download error: " + String(err), { status: 502, headers: corsHeaders });
  } finally {
    console.log(JSON.stringify({
      event: "download_request",
      videoId: id,
      durationMs: Date.now() - requestStartedAt,
      format,
    }));
  }
}

function directAudioRedirect(
  url: string,
  requestedFilename: string,
  title: string,
  extension = ".m4a",
): Response {
  const filename = safeFilename(requestedFilename || title || "audio");
  const encodedFilename = encodeURIComponent(`${filename}${extension}`);
  const fallbackFilename = `${filename.replace(/[^\x20-\x7E]/g, "").trim() || "audio"}${extension}`;
  const headers = new Headers(corsHeaders);
  headers.set("Location", url);
  headers.set("Cache-Control", "no-store");
  headers.set(
    "Content-Disposition",
    `attachment; filename="${fallbackFilename}"; filename*=UTF-8''${encodedFilename}`,
  );
  return new Response(null, { status: 302, headers });
}

async function fetchCachedAudio(
  record: { url: string; contentType?: string },
  req: Request,
): Promise<Response | null> {
  try {
    const headers: Record<string, string> = {
      "User-Agent": "Zefron-API/2.0",
      "Accept": record.contentType || "audio/*",
    };
    const range = req.headers.get("Range");
    if (range) headers["Range"] = range;

    const response = await fetch(record.url, {
      headers,
      signal: AbortSignal.any([
        req.signal,
        AbortSignal.timeout(CACHED_AUDIO_TIMEOUT_MS),
      ]),
    });
    if (!response.ok && response.status !== 206) {
      await response.body?.cancel();
      console.warn(`Cached audio fetch returned ${response.status}`);
      return null;
    }
    return response;
  } catch (err) {
    console.warn("Cached audio fetch failed:", String(err).slice(0, 160));
    return null;
  }
}

function createFastMp3Response(entry: FastMp3CacheEntry, req: Request): Response {
  const bytes = entry.bytes;
  const range = req.headers.get("Range");
  const headers = new Headers({
    "Content-Type": entry.contentType || "audio/mpeg",
    "Accept-Ranges": "bytes",
  });

  if (!range) {
    headers.set("Content-Length", String(bytes.byteLength));
    return new Response(bytes.slice(), { headers });
  }

  const match = /^bytes=(\d*)-(\d*)$/i.exec(range.trim());
  if (!match || (!match[1] && !match[2])) {
    headers.set("Content-Range", `bytes */${bytes.byteLength}`);
    return new Response(null, { status: 416, headers });
  }

  let start: number;
  let end: number;
  if (match[1]) {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : bytes.byteLength - 1;
  } else {
    const suffixLength = Number(match[2]);
    start = Math.max(0, bytes.byteLength - suffixLength);
    end = bytes.byteLength - 1;
  }

  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= bytes.byteLength ||
    end < start
  ) {
    headers.set("Content-Range", `bytes */${bytes.byteLength}`);
    return new Response(null, { status: 416, headers });
  }

  end = Math.min(end, bytes.byteLength - 1);
  const chunk = bytes.slice(start, end + 1);
  headers.set("Content-Length", String(chunk.byteLength));
  headers.set("Content-Range", `bytes ${start}-${end}/${bytes.byteLength}`);
  return new Response(chunk, { status: 206, headers });
}

export function handleWarmDownload(searchParams: URLSearchParams): Response {
  const rawInput = searchParams.get("id") || searchParams.get("url");
  if (!rawInput) return error("Missing id or url");
  const id = videoIdFromInput(rawInput);
  if (!id) return error("Invalid YouTube video ID or URL");

  // Do not make the player wait for the conversion job. The shared promise
  // ensures a later download request reuses this exact job.
  const format = (searchParams.get("format") || "mp3").toLowerCase();
  if (format === "mp3") {
    void ensureMp3Cached(id, 45_000);
  }
  else {
    void (async () => {
      if (!(await getCachedAudio(id, "original"))) await prepareFastAudio(id, 30_000);
    })();
  }
  return json({ success: true, status: "warming", id }, 202);
}

function createDownloadResponse(
  response: Response,
  requestedFilename: string,
  title: string,
  forcedContentType?: string,
): Response {
  const sourceContentType = forcedContentType || response.headers.get("Content-Type") || "audio/mp4";
  const filename = safeFilename(requestedFilename || title || "audio");
  const extension = forcedContentType === "audio/mpeg"
    ? ".mp3"
    : extensionForContentType(sourceContentType);
  const encodedFilename = encodeURIComponent(`${filename}${extension}`);
  const fallbackFilename =
    `${safeFilename(filename).replace(/[^\x20-\x7E]/g, "").trim() || "audio"}${extension}`;

  const responseHeaders = new Headers(corsHeaders);
  responseHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  responseHeaders.set("Access-Control-Allow-Headers", "Range, Content-Type");
  responseHeaders.set(
    "Access-Control-Expose-Headers",
    "Content-Length, Content-Range, Accept-Ranges, Content-Disposition",
  );
  responseHeaders.set("Content-Type", sourceContentType);
  responseHeaders.set(
    "Content-Disposition",
    `attachment; filename="${fallbackFilename}"; filename*=UTF-8''${encodedFilename}`,
  );
  responseHeaders.set("Cache-Control", "no-store");
  if (response.headers.get("Content-Length")) {
    responseHeaders.set("Content-Length", response.headers.get("Content-Length")!);
  }
  if (response.headers.get("Content-Range")) {
    responseHeaders.set("Content-Range", response.headers.get("Content-Range")!);
  }
  responseHeaders.set("Accept-Ranges", response.headers.get("Accept-Ranges") || "bytes");

  return new Response(response.body, { status: response.status, headers: responseHeaders });
}

export async function handleProxy(searchParams: URLSearchParams, req: Request): Promise<Response> {
  const audioUrl = searchParams.get("url");
  if (!audioUrl) return error("Missing url");

  try {
    const parsedUrl = new URL(audioUrl);
    if (
      !["http:", "https:"].includes(parsedUrl.protocol) ||
      parsedUrl.username ||
      parsedUrl.password ||
      isPrivateProxyHost(parsedUrl.hostname)
    ) {
      return error("Proxy URL is not allowed", 400);
    }

    const response = await fetch(parsedUrl, {
      headers: audioHeaders(req),
      signal: AbortSignal.any([
        req.signal,
        AbortSignal.timeout(MEDIA_SOURCE_TIMEOUT_MS),
      ]),
    });
    if (!response.ok && response.status !== 206) {
      return new Response(`Failed: ${response.status}`, { status: 502, headers: corsHeaders });
    }

    const responseHeaders = new Headers();
    responseHeaders.set("Access-Control-Allow-Origin", "*");
    responseHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    responseHeaders.set("Access-Control-Allow-Headers", "Range, Content-Type");
    responseHeaders.set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");
    responseHeaders.set("Cache-Control", "public, max-age=3600");
    responseHeaders.set("Content-Type", response.headers.get("Content-Type") || "audio/mp4");
    if (response.headers.get("Content-Length")) responseHeaders.set("Content-Length", response.headers.get("Content-Length")!);
    if (response.headers.get("Content-Range")) responseHeaders.set("Content-Range", response.headers.get("Content-Range")!);
    responseHeaders.set("Accept-Ranges", response.headers.get("Accept-Ranges") || "bytes");

    return new Response(response.body, { status: response.status, headers: responseHeaders });
  } catch (err) {
    return new Response("Proxy error: " + String(err), { status: 502, headers: corsHeaders });
  }
}

export async function handleMusicFind(searchParams: URLSearchParams, ytmusic: YTMusic): Promise<Response> {
  const name = searchParams.get("name"), artist = searchParams.get("artist");
  if (!name || !artist) return error("Missing name and artist");

  const searchResults = await ytmusic.search(`${name} ${artist}`, "songs");
  if (!searchResults.results?.length) return json({ success: false, error: "Song not found" }, 404);

  const normalize = (s: string) => s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/gi, "").toLowerCase();
  const nName = normalize(name);
  const artistsList = artist.split(",").map(a => normalize(a));

  const match = searchResults.results.find((song: any) => {
    const nSongName = normalize(song.title || "");
    const songArtists = (song.artists || []).map((a: any) => normalize(a.name || ""));
    return (nSongName.includes(nName) || nName.includes(nSongName)) &&
      artistsList.some(a => songArtists.some((sa: string) => sa.includes(a) || a.includes(sa)));
  });

  return match ? json({ success: true, data: match }) : json({ success: false, error: "Song not found" }, 404);
}
