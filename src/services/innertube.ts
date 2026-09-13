/**
 * Fast direct audio resolver.
 *
 * @ybd-project/ytdl-core uses YouTube's InnerTube player clients and
 * negotiates the signed media URL without starting a yt-dlp/FFmpeg job.
 */

import { YtdlCore } from "npm:@ybd-project/ytdl-core@6.0.7";
import { cookieHeader } from "./youtube-cookies.ts";

const innerTube = new YtdlCore({
  // We handle retry/fallback errors at the route level. Logging every failed
  // client here produces a misleading wall of errors for normal fallbacks.
  logDisplay: [],
  disablePoTokenAutoGeneration: true,
  disableFileCache: true,
  disableBasicCache: true,
  disableRetryRequest: true,
});

export type DirectAudioSource = {
  response: Response;
  title: string;
};

function bitrate(format: any): number {
  return Number(format.audioBitrate || format.bitrate || 0);
}

async function resolveInnerTubeSource(
  videoId: string,
  request: Request,
  cookie: string | null,
): Promise<DirectAudioSource | null> {
  const requestOptions: RequestInit = {
    headers: cookie ? { Cookie: cookie } : undefined,
    signal: AbortSignal.timeout(20_000),
  };
  const info = await innerTube.getFullInfo(
    `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
    {
      requestOptions,
      clients: ["ios", "android", "tvEmbedded"],
      disableRetryRequest: true,
      includesRelatedVideo: false,
    } as any,
  );

  const formats = (info.formats || [])
    .filter((format: any) =>
      format.url &&
      format.hasAudio &&
      !format.hasVideo &&
      (format.mimeType || "").startsWith("audio/")
    )
    .sort((a: any, b: any) => {
      const aMp4 = (a.mimeType || "").includes("mp4") ? 1 : 0;
      const bMp4 = (b.mimeType || "").includes("mp4") ? 1 : 0;
      return bMp4 - aMp4 || bitrate(b) - bitrate(a);
    });
  const format = formats[0];
  if (!format?.url) return null;

  const headers: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "audio/*,*/*",
    "Referer": "https://www.youtube.com/",
    "Origin": "https://www.youtube.com",
  };
  if (cookie) headers.Cookie = cookie;
  const range = request.headers.get("Range");
  if (range) headers.Range = range;
  const response = await fetch(format.url, {
    headers,
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok && response.status !== 206) {
    await response.body?.cancel();
    return null;
  }

  return {
    response,
    title: info.videoDetails?.title || "",
  };
}

export async function fetchFromInnerTube(
  videoId: string,
  request: Request,
): Promise<DirectAudioSource | null> {
  const cookie = await cookieHeader();
  // Try public access first so an expired cookie cannot block public videos.
  // Authenticated cookies remain available as a second attempt.
  const attempts = cookie ? [null, cookie] : [null];
  let lastError: unknown;

  for (const attemptCookie of attempts) {
    try {
      const source = await resolveInnerTubeSource(videoId, request, attemptCookie);
      if (source) return source;
    } catch (err) {
      lastError = err;
    }
  }

  if (lastError) {
    console.error(`InnerTube audio resolution failed for ${videoId}:`, String(lastError));
  }
  return null;
}