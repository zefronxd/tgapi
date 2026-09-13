/**
 * Streaming Service
 * Fetches audio stream URLs from Piped and Invidious instances
 */

import { findCookieFile } from "./youtube-cookies.ts";
import { cacheAudioOnGoogleDrive, getCachedAudio } from "./audio-cache.ts";
import {
  AsyncJobQueue,
  ffmpegQueue,
  getJobQueueSnapshots,
  ytDlpQueue,
} from "./job-queue.ts";

let instancesCache: any = null;
let instancesCacheTime = 0;
const CACHE_DURATION = 5 * 60 * 1000;
const INSTANCE_TIMEOUT_MS = 3500;
const MEDIA_SOURCE_TIMEOUT_MS = Math.max(
  10_000,
  Number(Deno.env.get("MEDIA_SOURCE_TIMEOUT_MS") || 60_000),
);
const MEDIA_BODY_TIMEOUT_MS = Math.max(
  30_000,
  Number(Deno.env.get("MEDIA_BODY_TIMEOUT_MS") || 120_000),
);
const MEDIA_PROVIDER_COOLDOWN_MS = Math.max(
  30_000,
  Number(Deno.env.get("MEDIA_PROVIDER_COOLDOWN_MS") || 120_000),
);
const DISABLED_MEDIA_PROVIDERS = new Set(
  (Deno.env.get("DISABLED_MEDIA_PROVIDERS") || "")
    .split(",")
    .map((value) => value.trim().replace(/\/+$/, ""))
    .filter(Boolean),
);
const STREAM_RESULT_CACHE_DURATION = 30 * 1000;
const pipedResultCache = new Map<string, { expiresAt: number; result: any }>();
const invidiousResultCache = new Map<string, { expiresAt: number; result: any }>();
const MP3_SOURCE_CACHE_DURATION = 90 * 1000;
const mp3SourceCache = new Map<string, { expiresAt: number; result: Mp3SourceResult }>();
const mp3SourceJobs = new Map<string, Promise<Mp3SourceResult>>();
const m4aSourceCache = new Map<string, { expiresAt: number; result: Mp3SourceResult }>();
const m4aSourceJobs = new Map<string, Promise<Mp3SourceResult>>();
const FAST_AUDIO_CACHE_DURATION = 90 * 1000;
const fastAudioCache = new Map<string, { expiresAt: number; result: PreparedAudioResult }>();
const fastAudioJobs = new Map<string, Promise<PreparedAudioResult>>();
const mp3AudioCache = new Map<string, { expiresAt: number; result: PreparedAudioResult }>();
const mp3AudioJobs = new Map<string, Promise<PreparedAudioResult>>();
const mp3CacheJobs = new Map<string, Promise<void>>();
const AUDIO_TEMP_DIR = Deno.env.get("AUDIO_TEMP_DIR") || "/tmp/zefron-audio";
const AUDIO_TEMP_MAX_AGE_MS = Math.max(
  5 * 60_000,
  Number(Deno.env.get("AUDIO_TEMP_MAX_AGE_MS") || 60 * 60_000),
);
const FFMPEG_TIMEOUT_MS = Math.max(
  10_000,
  Number(Deno.env.get("FFMPEG_TIMEOUT_MS") || 60_000),
);
const MP3_PROVIDER_TIMEOUT_MS = Math.max(
  15_000,
  Number(Deno.env.get("MP3_PROVIDER_TIMEOUT_MS") || 45_000),
);
const MP3_CACHE_ATTEMPTS = Math.max(
  1,
  Math.min(8, Number(Deno.env.get("MP3_CACHE_ATTEMPTS") || 5)),
);
const MP3_CACHE_RETRY_DELAY_MS = Math.max(
  1_000,
  Number(Deno.env.get("MP3_CACHE_RETRY_DELAY_MS") || 5_000),
);
const MP3_CACHE_CONCURRENCY = Math.max(
  1,
  Math.min(12, Number(Deno.env.get("MP3_CACHE_CONCURRENCY") || 6)),
);
const MP3_CACHE_QUEUE_LIMIT = Math.max(
  100,
  Number(Deno.env.get("MP3_CACHE_QUEUE_LIMIT") || 500),
);
const mp3CacheQueue = new AsyncJobQueue(
  "mp3-cache",
  MP3_CACHE_CONCURRENCY,
  MP3_CACHE_QUEUE_LIMIT,
);
const blockedMediaProviders = new Map<string, number>();

function normalizedProviderInstance(instance: string): string {
  return instance.trim().replace(/\/+$/, "");
}

function isMediaProviderBlocked(instance: string): boolean {
  const normalized = normalizedProviderInstance(instance);
  if (DISABLED_MEDIA_PROVIDERS.has(normalized)) return true;
  const blockedUntil = blockedMediaProviders.get(normalized);
  if (!blockedUntil) return false;
  if (blockedUntil <= Date.now()) {
    blockedMediaProviders.delete(normalized);
    return false;
  }
  return true;
}

function blockMediaProvider(instance: string, reason: string): void {
  const normalized = normalizedProviderInstance(instance);
  if (!normalized || normalized === "yt-dlp") return;
  blockedMediaProviders.set(normalized, Date.now() + MEDIA_PROVIDER_COOLDOWN_MS);
  console.warn(JSON.stringify({
    event: "audio_source",
    state: "provider_cooldown",
    provider: normalized,
    cooldownMs: MEDIA_PROVIDER_COOLDOWN_MS,
    reason,
  }));
}

async function firstSuccessful<T>(
  tasks: Array<(signal: AbortSignal) => Promise<T>>,
  timeoutMs: number,
  parentSignal?: AbortSignal,
  cleanupResult?: (result: T) => Promise<void>,
): Promise<T> {
  if (!tasks.length) throw new Error("No candidate requests");

  const controllers = tasks.map(() => new AbortController());
  const timers = controllers.map((controller) =>
    setTimeout(() => controller.abort(), Math.max(1, timeoutMs))
  );
  const resolvedResults = new Map<number, T>();
  let winnerIndex = -1;
  const abortAll = () => controllers.forEach((controller) => controller.abort());

  try {
    if (parentSignal?.aborted) throw new Error("Candidate requests aborted");
    parentSignal?.addEventListener("abort", abortAll, { once: true });
    const candidates = tasks.map((task, index) =>
      task(controllers[index].signal).then((result) => {
        resolvedResults.set(index, result);
        return { index, result };
      })
    );
    const winner = await Promise.any(candidates);
    winnerIndex = winner.index;
    return winner.result;
  } finally {
    timers.forEach((timer) => clearTimeout(timer));
    controllers.forEach((controller, index) => {
      if (index !== winnerIndex) controller.abort();
    });
    parentSignal?.removeEventListener("abort", abortAll);
    if (cleanupResult) {
      await Promise.all(
        [...resolvedResults.entries()]
          .filter(([index]) => index !== winnerIndex)
          .map(async ([, result]) => {
            try {
              await cleanupResult(result);
            } catch {
              // A losing response may already have been aborted upstream.
            }
          }),
      );
    }
  }
}

export async function fetchAudioResponseWithHeaderTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = MEDIA_SOURCE_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const parentSignal = init.signal;
  const forwardAbort = () => controller.abort();
  if (parentSignal?.aborted) throw new Error("Audio request aborted");
  parentSignal?.addEventListener("abort", forwardAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", forwardAbort);
  }
}

export type Mp3SourceResult =
  | { success: true; url: string; title: string }
  | { success: false; error: string };
export type PreparedAudioResult =
  | { success: true; filePath: string; size: number; title: string; contentType: string }
  | { success: false; error: string };
const LOW_QUALITY_MP3_BITRATE = "64k";

async function ensureAudioTempDir(): Promise<void> {
  await Deno.mkdir(AUDIO_TEMP_DIR, { recursive: true });
}

function tempAudioPath(extension = "mp3"): string {
  return `${AUDIO_TEMP_DIR}/zefron-${crypto.randomUUID()}.${extension}`;
}

async function removeTempFile(filePath: string): Promise<void> {
  await Deno.remove(filePath).catch(() => {});
}

async function cleanupAudioTempFiles(): Promise<void> {
  try {
    await ensureAudioTempDir();
    const cutoff = Date.now() - AUDIO_TEMP_MAX_AGE_MS;
    for await (const entry of Deno.readDir(AUDIO_TEMP_DIR)) {
      if (!entry.isFile || !entry.name.startsWith("zefron-")) continue;
      const path = `${AUDIO_TEMP_DIR}/${entry.name}`;
      const info = await Deno.stat(path).catch(() => null);
      if (info && info.mtime && info.mtime.getTime() < cutoff) {
        await removeTempFile(path);
      }
    }
  } catch (err) {
    console.warn("Audio temp cleanup failed:", String(err).slice(0, 160));
  }
}

void cleanupAudioTempFiles();
setInterval(() => void cleanupAudioTempFiles(), 10 * 60_000);

async function runYtDlp(args: string[], timeoutMs: number): Promise<Deno.CommandOutput | null> {
  try {
    return await ytDlpQueue.run("resolve-audio", async () => {
      const command = new Deno.Command("yt-dlp", {
        args,
        clearEnv: true,
        env: { PATH: Deno.env.get("PATH") || "/usr/bin:/bin" },
        stdout: "piped",
        stderr: "piped",
      });

      let child: Deno.ChildProcess;
      try {
        child = command.spawn();
      } catch {
        return null;
      }

      let timer: number | undefined;
      try {
        return await Promise.race([
          child.output(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              try {
                child.kill("SIGKILL");
              } catch {
                // The process may have already exited.
              }
              reject(new Error("yt-dlp timed out"));
            }, Math.max(1, timeoutMs));
          }),
        ]);
      } catch {
        return null;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    });
  } catch {
    return null;
  }
}

const PIPED_INSTANCES = [
  "https://api.piped.private.coffee",
  "https://pipedapi.darkness.services",
  "https://pipedapi.r4fo.com",
  "https://api.piped.yt",
  "https://pipedapi.kavin.rocks",
  "https://pipedapi.adminforge.de",
  "https://pipedapi.in.projectsegfau.lt",
  "https://api.piped.projectsegfau.lt",
  "https://pipedapi.leptons.xyz",
];

async function getDynamicInstances(timeoutMs = INSTANCE_TIMEOUT_MS) {
  const now = Date.now();
  if (instancesCache && (now - instancesCacheTime) < CACHE_DURATION) {
    return instancesCache;
  }

  try {
    const response = await fetch("https://raw.githubusercontent.com/n-ce/Uma/main/dynamic_instances.json", {
      signal: AbortSignal.timeout(Math.max(1, Math.min(INSTANCE_TIMEOUT_MS, timeoutMs))),
    });
    const data = await response.json();
    data.piped = PIPED_INSTANCES;
    instancesCache = data;
    instancesCacheTime = now;
    return instancesCache;
  } catch {
    return {
      piped: PIPED_INSTANCES,
      invidious: ["https://yt.omada.cafe", "https://y.com.sb", "https://inv.nadeko.net"],
    };
  }
}

export async function fetchFromPiped(
  videoId: string,
  excludedInstances: Set<string> = new Set(),
  timeoutMs = INSTANCE_TIMEOUT_MS,
  parentSignal?: AbortSignal,
) {
  const cached = pipedResultCache.get(videoId);
  if (
    cached &&
    cached.expiresAt > Date.now() &&
    !excludedInstances.has(cached.result.instance) &&
    !isMediaProviderBlocked(cached.result.instance)
  ) {
    return cached.result;
  }
  if (cached) pipedResultCache.delete(videoId);

  const instances = await getDynamicInstances(timeoutMs);
  const pipedInstances = (instances.piped || []).filter(
    (instance: string) =>
      !excludedInstances.has(instance) && !isMediaProviderBlocked(instance),
  );

  // Do not pay the latency of dead instances serially. The first healthy
  // instance wins, while the rest are aborted as soon as it responds.
  const candidates = pipedInstances.map((instance: string) => async (signal: AbortSignal) => {
    const response = await fetch(`${instance}/streams/${videoId}`, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      signal,
    });
    if (!response.ok) throw new Error(`Piped returned ${response.status}`);
    const data = await response.json();
    const audioStreams = data?.audioStreams || [];
    // Some videos expose no audio-only adaptive stream but still provide a
    // muxed MP4 (commonly itag 18). FFmpeg can extract the audio from it, so
    // keep those streams as a download fallback instead of rejecting a valid
    // video outright.
    const muxedStreams = (data?.videoStreams || []).filter((stream: any) =>
      stream?.url &&
      stream.videoOnly === false &&
      String(stream.mimeType || "").includes("video/mp4")
    );
    if (data?.error || (!audioStreams.length && !muxedStreams.length)) {
      throw new Error("No usable audio streams");
    }

    const instanceUrl = new URL(instance);
    const proxyHost = instanceUrl.host.replace("pipedapi", "pipedproxy").replace("api.", "proxy.");
    return {
      success: true,
      instance,
      streamingUrls: [...audioStreams, ...muxedStreams].map((s: any) => ({
        url: s.url,
        quality: s.quality,
        mimeType: s.mimeType,
        bitrate: s.bitrate,
        videoOnly: s.videoOnly,
        proxyHost,
      })),
      metadata: {
        id: videoId,
        title: data.title,
        uploader: data.uploader,
        thumbnail: data.thumbnailUrl,
        duration: data.duration,
        views: data.views,
      },
      hlsUrl: data.hls,
    };
  });

  try {
    const result = await firstSuccessful(
      candidates,
      Math.max(1, Math.min(INSTANCE_TIMEOUT_MS, timeoutMs)),
      parentSignal,
    );
    pipedResultCache.set(videoId, {
      expiresAt: Date.now() + STREAM_RESULT_CACHE_DURATION,
      result,
    });
    return result;
  } catch {
    // All instances failed or timed out.
  }

  return { success: false, error: "No working Piped instances found" };
}

export async function fetchFromInvidious(
  videoId: string,
  excludedInstances: Set<string> = new Set(),
  timeoutMs = INSTANCE_TIMEOUT_MS,
  parentSignal?: AbortSignal,
) {
  const cached = invidiousResultCache.get(videoId);
  if (
    cached &&
    cached.expiresAt > Date.now() &&
    !excludedInstances.has(cached.result.instance) &&
    !isMediaProviderBlocked(cached.result.instance)
  ) {
    return cached.result;
  }
  if (cached) invidiousResultCache.delete(videoId);

  const instances = await getDynamicInstances(timeoutMs);
  const invidiousInstances = (instances.invidious || []).filter(
    (instance: string) =>
      !excludedInstances.has(instance) && !isMediaProviderBlocked(instance),
  );
  const candidates = invidiousInstances.map((instance: string) => async (signal: AbortSignal) => {
    const response = await fetch(`${instance}/api/v1/videos/${videoId}`, {
      signal,
    });
    if (!response.ok) throw new Error(`Invidious returned ${response.status}`);
    const data = await response.json();
    const audioFormats = (data?.adaptiveFormats || []).filter((f: any) =>
      f.type?.includes("audio") || f.mimeType?.includes("audio")
    );
    if (!audioFormats.length) throw new Error("No audio formats");

    return {
      success: true,
      instance,
      streamingUrls: audioFormats.map((f: any) => ({
        url: `${instance}/latest_version?id=${videoId}&itag=${f.itag}`,
        directUrl: f.url,
        bitrate: f.bitrate,
        type: f.type,
        audioQuality: f.audioQuality,
        itag: f.itag,
      })),
      metadata: {
        id: videoId,
        title: data.title,
        author: data.author,
        thumbnail: data.videoThumbnails?.[0]?.url,
        lengthSeconds: data.lengthSeconds,
        viewCount: data.viewCount,
      },
    };
  });

  try {
    const result = await firstSuccessful(
      candidates,
      Math.max(1, Math.min(INSTANCE_TIMEOUT_MS, timeoutMs)),
      parentSignal,
    );
    invidiousResultCache.set(videoId, {
      expiresAt: Date.now() + STREAM_RESULT_CACHE_DURATION,
      result,
    });
    return result;
  } catch {
    // All instances failed or timed out.
  }

  return { success: false, error: "No working Invidious instances found" };
}

/**
 * Direct YouTube extractor fallback. This is intentionally time-bounded:
 * yt-dlp improves coverage for videos that public APIs reject, but it must
 * never bring back the old long-hanging download behavior.
 */
export async function fetchFromYtDlp(videoId: string, timeoutMs = INSTANCE_TIMEOUT_MS) {
  const cookieFile = await findCookieFile();
  const baseArgs = [
      "--no-playlist",
      "--no-warnings",
      "--skip-download",
      "--format", "bestaudio[abr<=160]/bestaudio",
      "--get-url",
      `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
    ];
  const attempts = cookieFile ? [[], ["--cookies", cookieFile]] : [[]];
  for (const cookieArgs of attempts) {
    const output = await runYtDlp([...baseArgs.slice(0, -1), ...cookieArgs, baseArgs.at(-1)!], timeoutMs);
    if (!output) continue;
    const urls = new TextDecoder().decode(output.stdout).split(/\r?\n/).map((url) => url.trim()).filter(Boolean);
    if (output.success && urls.length) {
      return {
        success: true,
        instance: "yt-dlp",
        streamingUrls: urls.map((url) => ({ url, bitrate: 128_000 })),
        metadata: { id: videoId, title: "" },
      };
    }
  }
  return { success: false, error: "yt-dlp found no audio URL" };
}

function audioContentType(path: string): string {
  const extension = path.toLowerCase().slice(path.lastIndexOf("."));
  if (extension === ".mp3") return "audio/mpeg";
  if (extension === ".webm") return "audio/webm";
  if (extension === ".opus") return "audio/ogg";
  if (extension === ".ogg") return "audio/ogg";
  if (extension === ".wav") return "audio/wav";
  return "audio/mp4";
}

async function cachedYtDlpAudio(videoId: string): Promise<{ response: Response; title: string } | null> {
  const safeId = videoId.replace(/[^A-Za-z0-9_-]/g, "");
  if (!safeId) return null;

  try {
    for await (const entry of Deno.readDir("downloads")) {
      if (!entry.isFile || !entry.name.startsWith(`${safeId}.`)) continue;
      const path = `downloads/${entry.name}`;
      const stat = await Deno.stat(path);
      if (stat.size < 4096) {
        await Deno.remove(path).catch(() => {});
        continue;
      }
      const bytes = await Deno.readFile(path);
      return {
        response: new Response(bytes, {
          headers: { "Content-Type": audioContentType(path) },
        }),
        title: safeId,
      };
    }
  } catch {
    // A cache miss should fall through to a fresh download.
  }
  return null;
}

/**
 * Download the media file with yt-dlp rather than resolving a URL first.
 * This mirrors the working Python downloader pattern: cookies, retries,
 * fragment concurrency, and a validated on-disk file before API delivery.
 */
export async function downloadWithYtDlp(
  videoId: string,
  timeoutMs = 45_000,
): Promise<{ response: Response; title: string } | null> {
  const cached = await cachedYtDlpAudio(videoId);
  if (cached) return cached;

  const safeId = videoId.replace(/[^A-Za-z0-9_-]/g, "");
  if (!safeId) return null;
  const cookieFile = await findCookieFile();

  try {
    await Deno.mkdir("downloads", { recursive: true });
  } catch {
    return null;
  }

  const baseArgs = [
      "--no-playlist",
      "--quiet",
      "--no-warnings",
      "--no-progress",
      "--format", "bestaudio/best",
      "--output", `downloads/${safeId}.%(ext)s`,
      "--continue",
      "--no-overwrites",
      "--geo-bypass",
      "--socket-timeout", "30",
      "--retries", "2",
      "--fragment-retries", "2",
      "--extractor-retries", "5",
      "--concurrent-fragments", "4",
      "--http-chunk-size", "524288",
      "--sleep-requests", "1",
      `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
    ];
  const attempts = cookieFile ? [[], ["--cookies", cookieFile]] : [[]];
  for (const cookieArgs of attempts) {
    const output = await runYtDlp([...baseArgs.slice(0, -1), ...cookieArgs, baseArgs.at(-1)!], timeoutMs);
    if (output?.success) {
      const downloaded = await cachedYtDlpAudio(videoId);
      if (downloaded) return downloaded;
    }
  }
  return null;
}

/**
 * Last-resort MP3 resolver for videos whose provider URLs are rejected by the
 * current server IP. The returned URL is fetched by our server and never sent
 * directly to the browser.
 */
export async function fetchFromAudioFallback(
  videoId: string,
  format: "mp3" | "m4a",
  timeoutMs = 60_000,
): Promise<Mp3SourceResult> {
  const deadline = Date.now() + timeoutMs;
  try {
    const sourceUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
    const startResponse = await fetch(
      `https://loader.to/ajax/download.php?format=${format}&url=${encodeURIComponent(sourceUrl)}`,
      {
        headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
        signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
      },
    );
    if (!startResponse.ok) return { success: false, error: `MP3 fallback returned ${startResponse.status}` };

    const job = await startResponse.json();
    if (job.url) {
      return { success: true, url: job.url, title: job.title || job.info?.title || "" };
    }
    if (!job.progress_url) return { success: false, error: "MP3 fallback did not return a progress URL" };

    for (let attempt = 0; attempt < 24 && Date.now() < deadline; attempt++) {
      // Poll quickly after the job is queued; most conversions finish in a
      // handful of seconds and there is no value in making the browser wait
      // for a coarse progress interval.
      const waitMs = Math.min(1000, Math.max(1, deadline - Date.now()));
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      if (Date.now() >= deadline) break;
      const progressResponse = await fetch(job.progress_url, {
        headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      });
      if (!progressResponse.ok) continue;

      const progress = await progressResponse.json();
      if (progress.success === 1 && progress.download_url) {
        return {
          success: true,
          url: progress.download_url,
          title: progress.title || job.title || job.info?.title || "",
        };
      }
      if (progress.success === -1) break;
    }
  } catch {
    // The primary providers already failed; return a consistent failure below.
  }

  return { success: false, error: `${format} fallback could not prepare the audio` };
}

export function fetchFromMp3Fallback(
  videoId: string,
  timeoutMs = 60_000,
): Promise<Mp3SourceResult> {
  return fetchFromAudioFallback(videoId, "mp3", timeoutMs);
}

export function prepareM4aSource(
  videoId: string,
  timeoutMs = 30_000,
): Promise<Mp3SourceResult> {
  const cached = m4aSourceCache.get(videoId);
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.result);
  if (cached) m4aSourceCache.delete(videoId);

  const active = m4aSourceJobs.get(videoId);
  if (active) return active;

  const job = fetchFromAudioFallback(videoId, "m4a", timeoutMs)
    .then((result): Mp3SourceResult => {
      if (result.success) {
        m4aSourceCache.set(videoId, {
          expiresAt: Date.now() + MP3_SOURCE_CACHE_DURATION,
          result,
        });
      }
      return result;
    })
    .finally(() => {
      m4aSourceJobs.delete(videoId);
    });

  m4aSourceJobs.set(videoId, job);
  return job;
}

export function getCachedFastAudio(videoId: string): PreparedAudioResult | null {
  const cached = fastAudioCache.get(videoId);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    fastAudioCache.delete(videoId);
    return null;
  }
  return cached.result;
}

type ProviderAudioSource = {
  response: Response;
  title: string;
};

async function fetchProviderAudioSource(
  provider: any,
  deadline: number,
  parentSignal?: AbortSignal,
): Promise<ProviderAudioSource> {
  if (!provider?.success) throw new Error("Provider has no audio source");
  if (parentSignal?.aborted) throw new Error("Provider request aborted");

  const streams = (provider.streamingUrls || []).filter((stream: any) =>
    stream?.url || stream?.directUrl
  );
  const audioStreams = streams.filter((stream: any) =>
    String(stream.mimeType || stream.type || "").startsWith("audio/")
  );
  const otherStreams = streams.filter((stream: any) => !audioStreams.includes(stream));
  const candidates = [...audioStreams, ...otherStreams].slice(0, 5);
  if (!candidates.length) throw new Error("Provider returned no usable streams");

  const sourceUrls = candidates.flatMap((stream: any) =>
    // Prefer the provider relay first. Signed direct URLs can be bound to the
    // provider's egress IP and may close the response body with a Deno
    // BadResource error when fetched from this server. Keep direct URLs as a
    // fallback for relays that are unavailable.
    [stream.url, stream.directUrl].filter(
      (url, index, urls) => url && urls.indexOf(url) === index
    )
  );
  const requests = sourceUrls.map((url: string, index: number) => async (signal: AbortSignal) => {
    const isRelay = Boolean(provider.instance && url.includes(provider.instance));
    const relayHeaders: Record<string, string> = isRelay && provider.instance
      ? {
        "Referer": `${provider.instance}/`,
        "Origin": provider.instance,
      }
      : {};
    console.log(JSON.stringify({
      event: "audio_source",
      state: "fetch_started",
      provider: provider.instance || "unknown",
      candidate: index,
      relay: isRelay,
    }));
    try {
      // The resolver signal is intentionally used only until headers arrive.
      // Reusing it for the response body aborts valid media while FFmpeg is
      // still spooling it, which appears as TimeoutError under load.
      const headerTimeoutMs = Math.max(
        1,
        Math.min(MEDIA_SOURCE_TIMEOUT_MS, Math.max(1, deadline - Date.now())),
      );
      const response = await fetchAudioResponseWithHeaderTimeout(
        url,
        {
          headers: {
            "User-Agent": "Mozilla/5.0",
            "Accept": "audio/*,video/mp4,*/*",
            ...relayHeaders,
          },
          signal,
        },
        headerTimeoutMs,
      );
      if (!response.ok && response.status !== 206) {
        await response.body?.cancel();
        if (response.status === 403) {
          blockMediaProvider(provider.instance || "", "provider returned 403");
        }
        throw new Error(`Provider audio returned ${response.status}`);
      }

      const contentType = (response.headers.get("Content-Type") || "").toLowerCase();
      if (
        contentType.includes("mpegurl") ||
        contentType.includes("hls") ||
        /\.m3u8(?:$|[?#])/i.test(url)
      ) {
        await response.body?.cancel();
        throw new Error("Provider returned an HLS playlist");
      }
      console.log(JSON.stringify({
        event: "audio_source",
        state: "headers_received",
        provider: provider.instance || "unknown",
        candidate: index,
        status: response.status,
        contentType,
        contentLength: response.headers.get("Content-Length") || "",
      }));
      return { response, title: provider.metadata?.title || "" };
    } catch (err) {
      console.warn(JSON.stringify({
        event: "audio_source",
        state: "fetch_failed",
        provider: provider.instance || "unknown",
        candidate: index,
        error: String(err).slice(0, 180),
      }));
      throw err;
    }
  });

  return await firstSuccessful(
    requests,
    MEDIA_SOURCE_TIMEOUT_MS,
    parentSignal,
    async (result) => {
      await result.response.body?.cancel();
    },
  );
}

async function saveResponseToAudioFile(
  response: Response,
  title: string,
  contentType: string,
  extension: string,
  maxBytes = 8 * 1024 * 1024,
): Promise<PreparedAudioResult> {
  if (!response.body) return { success: false, error: "Audio source had no body" };
  const filePath = tempAudioPath(extension);
  try {
    await ensureAudioTempDir();
    console.log(JSON.stringify({
      event: "audio_source",
      state: "spool_started",
      title,
      contentType,
      extension,
    }));
    const file = await Deno.open(filePath, { create: true, write: true, truncate: true });
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      // Do not use pipeTo here. Its automatic destination closing previously
      // raced with the explicit Deno file close and surfaced as
      // "BadResource: Bad resource ID" after a successful download. Manual
      // writes keep ownership of the file lifecycle in this function and
      // allow the size limit to be enforced while the response is streaming.
      reader = response.body.getReader();
      const bodyDeadline = Date.now() + MEDIA_BODY_TIMEOUT_MS;
      let writtenTotal = 0;
      while (true) {
        const remainingBodyMs = bodyDeadline - Date.now();
        if (remainingBodyMs <= 0) {
          throw new Error("Audio source body timed out");
        }
        let timeoutHandle: number | undefined;
        const chunk = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(
              () => reject(new Error("Audio source body timed out")),
              remainingBodyMs,
            );
          }),
        ]).finally(() => {
          if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        });
        if (chunk.done) break;
        if (!chunk.value?.byteLength) continue;

        writtenTotal += chunk.value.byteLength;
        if (writtenTotal > maxBytes) {
          throw new Error("Audio source is unexpectedly large");
        }

        let offset = 0;
        while (offset < chunk.value.byteLength) {
          offset += await file.write(chunk.value.subarray(offset));
        }
      }
    } catch (err) {
      await reader?.cancel().catch(() => {});
      throw err;
    } finally {
      reader?.releaseLock();
      file.close();
    }
    const info = await Deno.stat(filePath);
    if (info.size < 1024) {
      await removeTempFile(filePath);
      return { success: false, error: "Audio source was empty" };
    }
    if (info.size > maxBytes) {
      await removeTempFile(filePath);
      return { success: false, error: "Audio source is unexpectedly large" };
    }
    console.log(JSON.stringify({
      event: "audio_source",
      state: "spool_complete",
      title,
      contentType,
      extension,
      size: info.size,
    }));
    return { success: true, filePath, size: info.size, title, contentType };
  } catch (err) {
    console.warn(JSON.stringify({
      event: "audio_source",
      state: "spool_failed",
      title,
      contentType,
      extension,
      error: String(err).slice(0, 240),
    }));
    await removeTempFile(filePath);
    return { success: false, error: String(err) };
  }
}

async function prepareMp3FromProviders(
  videoId: string,
  timeoutMs: number,
): Promise<PreparedAudioResult> {
  const deadline = Date.now() + Math.max(1, Math.min(timeoutMs, MP3_PROVIDER_TIMEOUT_MS));
  const providers = [
    async (signal: AbortSignal) => {
      const remainingMs = Math.max(1, deadline - Date.now());
      const provider = await fetchFromPiped(
        videoId,
        new Set(),
        Math.min(INSTANCE_TIMEOUT_MS, remainingMs),
        signal,
      );
      return fetchProviderAudioSource(provider, deadline, signal);
    },
    async (signal: AbortSignal) => {
      const remainingMs = Math.max(1, deadline - Date.now());
      const provider = await fetchFromInvidious(
        videoId,
        new Set(),
        Math.min(INSTANCE_TIMEOUT_MS, remainingMs),
        signal,
      );
      return fetchProviderAudioSource(provider, deadline, signal);
    },
    async (signal: AbortSignal) => {
      if (signal.aborted) throw new Error("Provider request aborted");
      const provider = await fetchFromYtDlp(
        videoId,
        Math.min(12_000, Math.max(1, deadline - Date.now())),
      );
      return fetchProviderAudioSource(provider, deadline, signal);
    },
  ];

  try {
    const source = await firstSuccessful(
      providers,
      Math.max(1, Math.min(MP3_PROVIDER_TIMEOUT_MS, timeoutMs)),
      undefined,
      async (result) => {
        await result.response.body?.cancel();
      },
    );
    return await transcodeToSmallMp3(
      source.response,
      source.title,
      FFMPEG_TIMEOUT_MS,
    );
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

export function getCachedMp3Audio(videoId: string): PreparedAudioResult | null {
  const cached = mp3AudioCache.get(videoId);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    mp3AudioCache.delete(videoId);
    return null;
  }
  return cached.result;
}

export function prepareMp3Audio(
  videoId: string,
  timeoutMs = 45_000,
): Promise<PreparedAudioResult> {
  const cached = mp3AudioCache.get(videoId);
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.result);
  if (cached) mp3AudioCache.delete(videoId);

  const active = mp3AudioJobs.get(videoId);
  if (active) return active;

  const job = (async (): Promise<PreparedAudioResult> => {
    const deadline = Date.now() + Math.max(1, timeoutMs);
    // Provider streams are usually faster and cover videos that the single
    // external MP3 converter cannot resolve. This also accepts muxed MP4
    // streams and lets FFmpeg extract their audio.
    const providerAudio = await prepareMp3FromProviders(
      videoId,
      Math.max(1, deadline - Date.now()),
    );
    if (providerAudio.success) {
      mp3AudioCache.set(videoId, {
        expiresAt: Date.now() + FAST_AUDIO_CACHE_DURATION,
        result: providerAudio,
      });
      return providerAudio;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return providerAudio;
    const source = await prepareMp3Source(videoId, remainingMs);
    if (!source.success) return source;

    try {
      const sourceTimeoutMs = Math.max(1, Math.min(20_000, deadline - Date.now()));
      const response = await fetchAudioResponseWithHeaderTimeout(
        source.url,
        { headers: { "User-Agent": "Mozilla/5.0", "Accept": "audio/mpeg,audio/*,*/*" } },
        sourceTimeoutMs,
      );
      if (!response.ok) {
        await response.body?.cancel();
        return { success: false, error: `MP3 source returned ${response.status}` };
      }

        const result = await transcodeToSmallMp3(
         response,
         source.title,
          FFMPEG_TIMEOUT_MS,
       );
       if (!result.success) return result;
      mp3AudioCache.set(videoId, {
        expiresAt: Date.now() + FAST_AUDIO_CACHE_DURATION,
        result,
      });
      return result;
    } catch (err) {
      return { success: false, error: String(err) };
    }
  })().finally(() => {
    mp3AudioJobs.delete(videoId);
  });

  mp3AudioJobs.set(videoId, job);
  return job;
}

/**
 * Start the persistent MP3 cache independently from the HTTP response.
 * A browser may cancel its request while conversion is still running; this
 * detached job must continue so the completed MP3 is still uploaded to the
 * Telegram cache channel.
 */
export function ensureMp3Cached(
  videoId: string,
  timeoutMs = 45_000,
): Promise<void> {
  const active = mp3CacheJobs.get(videoId);
  if (active) return active;

  const job = mp3CacheQueue.run(`mp3:${videoId}`, async () => {
    console.log(JSON.stringify({
      event: "background_cache",
      state: "started",
      videoId,
    }));

    for (let attempt = 1; attempt <= MP3_CACHE_ATTEMPTS; attempt++) {
      const existing = await getCachedAudio(videoId, "mp3", false);
      if (existing?.provider === "telegram") {
        console.log(JSON.stringify({
          event: "background_cache",
          state: "already_cached",
          videoId,
          attempt,
        }));
        return;
      }

      const audio = await prepareMp3Audio(videoId, timeoutMs);
      if (audio.success) {
        // Force a Telegram attempt even if an earlier fallback created a
        // Google Drive record. Telegram is the durable cache for MP3s.
        const cached = await cacheAudioOnGoogleDrive(videoId, audio, true, "mp3");
        if (cached?.provider === "telegram") {
          console.log(JSON.stringify({
            event: "background_cache",
            state: "completed",
            videoId,
            attempt,
          }));
          return;
        }
      } else {
        console.warn(JSON.stringify({
          event: "background_cache",
          state: "prepare_failed",
          videoId,
          attempt,
          error: audio.error,
        }));
      }

      if (attempt < MP3_CACHE_ATTEMPTS) {
        const delayMs = Math.min(
          60_000,
          MP3_CACHE_RETRY_DELAY_MS * 2 ** (attempt - 1),
        );
        console.warn(JSON.stringify({
          event: "background_cache",
          state: "retry_scheduled",
          videoId,
          attempt,
          delayMs,
        }));
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    console.warn(JSON.stringify({
      event: "background_cache",
      state: "exhausted",
      videoId,
      attempts: MP3_CACHE_ATTEMPTS,
    }));
  })
    .catch((err) => {
      console.warn("Background MP3 cache failed:", String(err).slice(0, 160));
    })
    .finally(() => {
      mp3CacheJobs.delete(videoId);
    });

  mp3CacheJobs.set(videoId, job);
  return job;
}

export function prepareFastAudio(
  videoId: string,
  timeoutMs = 30_000,
): Promise<PreparedAudioResult> {
  const cached = getCachedFastAudio(videoId);
  if (cached) return Promise.resolve(cached);

  const active = fastAudioJobs.get(videoId);
  if (active) return active;

  const job = (async (): Promise<PreparedAudioResult> => {
    const source = await prepareM4aSource(videoId, timeoutMs);
    if (!source.success) return source;

    try {
      const response = await fetchAudioResponseWithHeaderTimeout(
        source.url,
        { headers: { "User-Agent": "Mozilla/5.0", "Accept": "audio/mp4,audio/*,*/*" } },
        Math.min(20_000, timeoutMs),
      );
      if (!response.ok) {
        await response.body?.cancel();
        return { success: false, error: `Fast audio source returned ${response.status}` };
      }

      const contentLength = Number(response.headers.get("Content-Length") || "0");
      if (contentLength > 8 * 1024 * 1024) {
        await response.body?.cancel();
        return { success: false, error: "Fast audio source is unexpectedly large" };
      }

       const result = await saveResponseToAudioFile(
         response,
         source.title,
         response.headers.get("Content-Type") || "audio/mp4",
         "m4a",
       );
       if (!result.success) return result;
      while (fastAudioCache.size >= 8) {
        const oldest = fastAudioCache.keys().next().value;
        if (!oldest) break;
        fastAudioCache.delete(oldest);
      }
      fastAudioCache.set(videoId, {
        expiresAt: Date.now() + FAST_AUDIO_CACHE_DURATION,
        result,
      });
      void cacheAudioOnGoogleDrive(videoId, result, false, "original");
      return result;
    } catch (err) {
      return { success: false, error: String(err) };
    }
  })().finally(() => {
    fastAudioJobs.delete(videoId);
  });

  fastAudioJobs.set(videoId, job);
  return job;
}

/**
 * Start one MP3 conversion per video and reuse its short-lived result.
 * The player calls this before the user clicks Download, removing the
 * conversion setup time from the visible download action.
 */
export function prepareMp3Source(
  videoId: string,
  timeoutMs = 45_000,
): Promise<Mp3SourceResult> {
  const cached = mp3SourceCache.get(videoId);
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.result);
  if (cached) mp3SourceCache.delete(videoId);

  const active = mp3SourceJobs.get(videoId);
  if (active) return active;

  const job = fetchFromMp3Fallback(videoId, timeoutMs)
    .then((result): Mp3SourceResult => {
      if (result.success) {
        mp3SourceCache.set(videoId, {
          expiresAt: Date.now() + MP3_SOURCE_CACHE_DURATION,
          result,
        });
      }
      return result;
    })
    .finally(() => {
      mp3SourceJobs.delete(videoId);
    });

  mp3SourceJobs.set(videoId, job);
  return job;
}

/**
 * Convert the prepared source to a small MP3 before it reaches the browser.
 * FFmpeg output is written to a temporary file instead of being accumulated
 * in stdout memory. The queue limits active FFmpeg processes across all users.
 */
export async function transcodeToSmallMp3(
  source: Response,
  title = "",
  timeoutMs = FFMPEG_TIMEOUT_MS,
): Promise<PreparedAudioResult> {
  // Detach the network body from FFmpeg. Piping a fetch response directly into
  // ffmpeg makes an upstream timeout/cancellation surface as Deno's
  // "Interrupted: operation canceled" and can leave the conversion in a
  // half-closed state. Saving first also makes retries deterministic.
  const sourceFile = await saveResponseToAudioFile(
    source,
    title,
    source.headers.get("Content-Type") || "application/octet-stream",
    "input",
    32 * 1024 * 1024,
  );
  if (!sourceFile.success) return sourceFile;

  try {
    return await ffmpegQueue.run("mp3-conversion", async () => {
      const filePath = tempAudioPath("mp3");
      let child: Deno.ChildProcess | null = null;
      let stderrPromise: Promise<string> | null = null;
      let keepOutput = false;
      const startedAt = Date.now();

      try {
        await ensureAudioTempDir();
        child = new Deno.Command("ffmpeg", {
          args: [
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            sourceFile.filePath,
            "-vn",
            "-map_metadata",
            "-1",
            "-codec:a",
            "libmp3lame",
            "-b:a",
            LOW_QUALITY_MP3_BITRATE,
            "-f",
            "mp3",
            filePath,
          ],
          clearEnv: true,
          env: { PATH: Deno.env.get("PATH") || "/usr/bin:/bin" },
          stdout: "null",
          stderr: "piped",
        }).spawn();

        // Attach stderr immediately so a failed process cannot leave an
        // unhandled stream rejection behind.
        stderrPromise = new Response(child.stderr).text().catch(() => "");
        const statusPromise = child.status;
        let timer: number | undefined;
        let timedOut = false;
        let status: Deno.CommandStatus | null = null;

        try {
          status = await Promise.race([
            statusPromise,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                timedOut = true;
                reject(new Error("ffmpeg timed out"));
              }, Math.max(1, timeoutMs));
            }),
          ]);
        } catch (err) {
          try {
            child.kill("SIGKILL");
          } catch {
            // The process may have already exited.
          }
          await Promise.allSettled([statusPromise, stderrPromise]);
          return {
            success: false,
            error: timedOut ? "FFmpeg timed out" : String(err),
          };
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }

        const stderr = await stderrPromise;
        if (!status?.success) {
          return {
            success: false,
            error: `FFmpeg failed: ${stderr.slice(0, 240) || "process exited unsuccessfully"}`,
          };
        }

        const info = await Deno.stat(filePath);
        if (info.size < 1024) {
          return { success: false, error: "FFmpeg output was empty" };
        }
        console.log(JSON.stringify({
          event: "audio_job",
          state: "ffmpeg_complete",
          durationMs: Date.now() - startedAt,
          size: info.size,
        }));
        keepOutput = true;
        return {
          success: true,
          filePath,
          size: info.size,
          title,
          contentType: "audio/mpeg",
        };
      } catch (err) {
        return { success: false, error: String(err) };
      } finally {
        if (child) {
          try {
            child.kill("SIGKILL");
          } catch {
            // The process may have already exited.
          }
        }
        if (!keepOutput) await removeTempFile(filePath);
      }
    });
  } catch (err) {
    return { success: false, error: String(err) };
  } finally {
    await removeTempFile(sourceFile.filePath);
  }
}

export async function openPreparedAudio(
  audio: Extract<PreparedAudioResult, { success: true }>,
): Promise<Response | null> {
  try {
    const file = await Deno.open(audio.filePath, { read: true });
    return new Response(file.readable, {
      headers: {
        "Content-Type": audio.contentType,
        "Content-Length": String(audio.size),
      },
    });
  } catch {
    return null;
  }
}

export function getStreamingMetrics(): { queues: ReturnType<typeof getJobQueueSnapshots> } {
  return { queues: getJobQueueSnapshots() };
}
