import { ReplitConnectors } from "@replit/connectors-sdk";
import postgres from "postgres";
import type { PreparedAudioResult } from "./streaming.ts";

const TELEGRAM_UPLOAD_DELAY_MS = Math.max(
  0,
  Number(Deno.env.get("TELEGRAM_UPLOAD_DELAY_MS") || 1_100),
);
const TELEGRAM_UPLOAD_RETRIES = Math.max(
  0,
  Math.min(6, Number(Deno.env.get("TELEGRAM_UPLOAD_RETRIES") || 4)),
);
// Do not make a cache lookup wait on Telegram's getFile API. The persisted
// URL is tried immediately; a stale URL is refreshed only after that fetch
// fails. Keep this budget capped so a million-row DB still has a fast lookup
// path even when Telegram is slow.
const TELEGRAM_URL_REFRESH_BUDGET_MS = Math.max(
  250,
  Math.min(
    5_000,
    Number(Deno.env.get("TELEGRAM_URL_REFRESH_BUDGET_MS") || 1_500),
  ),
);
// This path runs only after a cached media URL failed. Give Telegram's
// getFile call enough time to return a fresh URL before rebuilding the audio.
const TELEGRAM_URL_REFRESH_FALLBACK_BUDGET_MS = Math.max(
  1_000,
  Math.min(
    15_000,
    Number(Deno.env.get("TELEGRAM_URL_REFRESH_FALLBACK_BUDGET_MS") || 10_000),
  ),
);
const MEMORY_CACHE_TTL_MS = Math.max(
  10_000,
  Number(Deno.env.get("AUDIO_MEMORY_CACHE_TTL_MS") || 5 * 60_000),
);

export type CachedAudioRecord = {
  videoId: string;
  format?: "original" | "mp3";
  url: string;
  title: string;
  contentType: string;
  size: number;
  provider: "google-drive" | "telegram";
  driveFileId?: string;
  telegramFileId?: string;
  telegramMessageId?: number;
  createdAt: Date;
};

type PostgresClient = ReturnType<typeof postgres>;

let postgresClient: PostgresClient | null = null;
let postgresConnectionPromise: Promise<PostgresClient | null> | null = null;
const connectors = new ReplitConnectors();
const cacheJobs = new Map<string, Promise<CachedAudioRecord | null>>();
const memoryCache = new Map<string, { record: CachedAudioRecord; expiresAt: number }>();
const cacheLookupJobs = new Map<string, Promise<CachedAudioRecord | null>>();
const telegramMessageLookupJobs = new Map<string, Promise<CachedAudioRecord | null>>();
// Telegram accepts an upload before PostgreSQL may finish its write. Keep the
// successful upload in memory so a storage retry never uploads the same bytes
// again when the database is briefly unavailable.
const pendingTelegramRecords = new Map<string, CachedAudioRecord>();
const pendingTelegramPersistJobs = new Map<string, Promise<void>>();
let telegramUploadTail: Promise<void> = Promise.resolve();
let telegramUploadReadyAt = 0;

const STORAGE_WRITE_ATTEMPTS = Math.max(
  2,
  Math.min(6, Number(Deno.env.get("AUDIO_CACHE_WRITE_ATTEMPTS") || 4)),
);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function cacheKey(videoId: string, format: "original" | "mp3"): string {
  return `${format}:${videoId}`;
}

function rememberCachedAudio(
  videoId: string,
  format: "original" | "mp3",
  record: CachedAudioRecord,
): void {
  memoryCache.set(cacheKey(videoId, format), {
    record,
    expiresAt: Date.now() + MEMORY_CACHE_TTL_MS,
  });
}

async function getPostgres(): Promise<PostgresClient | null> {
  const url = Deno.env.get("DATABASE_URL")?.trim();
  if (!url) return null;
  if (postgresClient) return postgresClient;
  if (postgresConnectionPromise) return postgresConnectionPromise;

  postgresConnectionPromise = (async () => {
    try {
      const client = postgres(url, {
        max: 10,
        connect_timeout: 5,
        idle_timeout: 20,
        prepare: false,
      });
      await Promise.race([
        client`SELECT 1`,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("PostgreSQL connection timeout")), 5000)
        ),
      ]);
      postgresClient = client;
      console.log("PostgreSQL audio cache connection ready");
      return client;
    } catch (err) {
      console.warn("PostgreSQL audio cache unavailable:", String(err).slice(0, 160));
      return null;
    } finally {
      postgresConnectionPromise = null;
    }
  })();

  return postgresConnectionPromise;
}

async function readCachedAudioFromStorage(
  videoId: string,
  format: "original" | "mp3" = "original",
  refreshTelegramUrl = true,
  refreshBudgetMs = TELEGRAM_URL_REFRESH_BUDGET_MS,
): Promise<CachedAudioRecord | null> {
  const sql = await getPostgres();
  if (!sql) return null;
  try {
    const record = await Promise.race([
      sql<CachedAudioRecord[]>`
        SELECT
          video_id AS "videoId",
          format,
          url,
          title,
          content_type AS "contentType",
          size::int AS size,
          provider,
          drive_file_id AS "driveFileId",
          telegram_file_id AS "telegramFileId",
          telegram_message_id::int AS "telegramMessageId",
          created_at AS "createdAt"
        FROM audio_cache
        WHERE video_id = ${videoId} AND format = ${format}
        LIMIT 1
      `.then((rows) => rows[0] || null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
    ]);
    if (!record) return null;

    // Telegram file URLs contain the bot token and expire. Resolve a fresh
    // download URL on every cache hit while keeping only the stable file_id
    // in PostgreSQL.
    if (refreshTelegramUrl && record.provider === "telegram" && record.telegramFileId) {
      const refresh = getTelegramFileUrl(record.telegramFileId);
      const url = await Promise.race([
        refresh,
        sleep(refreshBudgetMs).then(() => null),
      ]);
      // Telegram file URLs are refreshed on cache hits, but a transient
      // getFile failure should not turn a valid persisted cache record into a
      // miss. The upload-time URL is still usable until Telegram rotates its
      // file path; a later request can refresh it again. If the refresh is
      // slow, keep it running but return the stored URL within the budget.
      const result = url ? { ...record, url } : (record.url ? record : null);
      if (result && refresh) {
        void refresh.then((freshUrl) => {
          if (freshUrl) rememberCachedAudio(videoId, format, { ...record, url: freshUrl });
        });
      }
      return result;
    }
    return record;
  } catch (err) {
    console.warn("PostgreSQL audio lookup failed:", String(err).slice(0, 160));
    return null;
  }
}

export function getCachedAudio(
  videoId: string,
  format: "original" | "mp3" = "original",
  refreshTelegramUrl = true,
): Promise<CachedAudioRecord | null> {
  const key = cacheKey(videoId, format);
  const pending = pendingTelegramRecords.get(key);
  if (pending) return Promise.resolve(pending);

  const inMemory = memoryCache.get(key);
  if (inMemory) {
    if (inMemory.expiresAt > Date.now()) {
      return Promise.resolve(inMemory.record);
    }
    memoryCache.delete(key);
  }

  const active = cacheLookupJobs.get(key);
  if (active) return active;

  const lookup = readCachedAudioFromStorage(videoId, format, refreshTelegramUrl)
    .then((record) => {
      if (record) rememberCachedAudio(videoId, format, record);
      return record;
    })
    .finally(() => {
      cacheLookupJobs.delete(key);
    });
  cacheLookupJobs.set(key, lookup);
  return lookup;
}

/**
 * Refresh a Telegram-backed cache record after its persisted URL fails.
 * This is intentionally outside the normal lookup path so a stale Telegram
 * URL cannot make every cold DB lookup wait on the Telegram API.
 */
export async function refreshCachedAudioUrl(
  videoId: string,
  format: "original" | "mp3" = "mp3",
): Promise<CachedAudioRecord | null> {
  const record = await readCachedAudioFromStorage(
    videoId,
    format,
    true,
    TELEGRAM_URL_REFRESH_FALLBACK_BUDGET_MS,
  );
  if (record) rememberCachedAudio(videoId, format, record);
  return record;
}

export function getCachedTelegramMessage(
  videoId: string,
  format: "original" | "mp3" = "mp3",
): Promise<CachedAudioRecord | null> {
  const key = cacheKey(videoId, format);
  const inMemory = memoryCache.get(key);
  if (inMemory) {
    if (
      inMemory.expiresAt > Date.now() &&
      inMemory.record.provider === "telegram" &&
      inMemory.record.telegramMessageId
    ) {
      return Promise.resolve(inMemory.record);
    }
    if (inMemory.expiresAt <= Date.now()) memoryCache.delete(key);
  }

  const active = telegramMessageLookupJobs.get(key);
  if (active) return active;

  const lookup = readCachedAudioFromStorage(videoId, format, false)
    .then((record) => {
      if (record) rememberCachedAudio(videoId, format, record);
      return record?.provider === "telegram" && record.telegramMessageId ? record : null;
    })
    .finally(() => {
      telegramMessageLookupJobs.delete(key);
    });
  telegramMessageLookupJobs.set(key, lookup);
  return lookup;
}

function telegramConfig(): { token: string; channelId: string } | null {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN")?.trim();
  const channelId = (
    Deno.env.get("TELEGRAM_CACHE_CHANNEL_ID") ||
    Deno.env.get("TELEGRAM_CHANNEL_ID")
  )?.trim();
  return token && channelId ? { token, channelId } : null;
}

async function telegramApi(
  token: string,
  method: string,
  init: RequestInit = {},
): Promise<any | null> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      ...init,
      signal: init.signal || AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.ok ? data.result : null;
  } catch {
    return null;
  }
}

async function getTelegramFileUrl(fileId: string): Promise<string | null> {
  const config = telegramConfig();
  if (!config) return null;
  for (let attempt = 0; attempt <= TELEGRAM_UPLOAD_RETRIES; attempt++) {
    const file = await telegramApi(config.token, "getFile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: fileId }),
    });
    if (file?.file_path) {
      return `https://api.telegram.org/file/bot${config.token}/${file.file_path}`;
    }
    if (attempt < TELEGRAM_UPLOAD_RETRIES) {
      await sleep(Math.min(8_000, 500 * 2 ** attempt));
    }
  }
  return null;
}

async function uploadToTelegram(
  videoId: string,
  audio: Extract<PreparedAudioResult, { success: true }>,
): Promise<{ fileId: string; messageId: number; url: string } | null> {
  const config = telegramConfig();
  if (!config) return null;

  const extension = audio.contentType.includes("mpeg") ? "mp3" : "m4a";
  const bytes = await Deno.readFile(audio.filePath);

  for (let attempt = 0; attempt <= TELEGRAM_UPLOAD_RETRIES; attempt++) {
    try {
      // FormData bodies cannot be reused after a fetch, so create a fresh one
      // for every retry.
      const form = new FormData();
      form.set("chat_id", config.channelId);
      form.set("caption", `Zefron cache\nVideo ID: ${videoId}`);
      form.set(
        "audio",
        new File([bytes], `zefron-${videoId}.${extension}`, {
          type: audio.contentType || "audio/mp4",
        }),
      );
      const response = await fetch(`https://api.telegram.org/bot${config.token}/sendAudio`, {
        method: "POST",
        body: form,
        // Uploads can take longer than media preparation when Telegram is
        // under load. Let the retry loop handle a real timeout instead of
        // abandoning a valid upload too early.
        signal: AbortSignal.timeout(120_000),
      });

      let payload: any = null;
      try {
        payload = await response.json();
      } catch {
        // Keep the response status as the useful failure detail.
      }

      const message = response.ok && payload?.ok ? payload.result : null;
      const fileId = message?.audio?.file_id || message?.document?.file_id;
      if (fileId && message?.message_id) {
        const url = await getTelegramFileUrl(fileId);
        if (url) return { fileId, messageId: message.message_id, url };
      }

      const retryable = response.status === 429 || response.status >= 500;
      const retryAfterMs = Math.max(
        0,
        Number(payload?.parameters?.retry_after || 0) * 1_000,
      );
      console.warn(JSON.stringify({
        event: "telegram_upload_failed",
        videoId,
        attempt: attempt + 1,
        status: response.status,
        retryable,
        retryAfterMs,
      }));
      if (!retryable || attempt >= TELEGRAM_UPLOAD_RETRIES) return null;
      await sleep(Math.max(retryAfterMs, Math.min(15_000, 1_000 * 2 ** attempt)));
    } catch (err) {
      console.warn(JSON.stringify({
        event: "telegram_upload_error",
        videoId,
        attempt: attempt + 1,
        error: String(err).slice(0, 160),
      }));
      if (attempt >= TELEGRAM_UPLOAD_RETRIES) return null;
      await sleep(Math.min(15_000, 1_000 * 2 ** attempt));
    }
  }
  return null;
}

async function queueTelegramUpload(
  videoId: string,
  audio: Extract<PreparedAudioResult, { success: true }>,
): Promise<{ fileId: string; messageId: number; url: string } | null> {
  const previous = telegramUploadTail;
  const run = previous.catch(() => {}).then(async () => {
    const waitMs = telegramUploadReadyAt - Date.now();
    if (waitMs > 0) await sleep(waitMs);
    const result = await uploadToTelegram(videoId, audio);
    telegramUploadReadyAt = Date.now() + TELEGRAM_UPLOAD_DELAY_MS;
    return result;
  });
  telegramUploadTail = run.then(() => undefined, () => undefined);
  return run;
}

type DriveRequestOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit;
};

async function driveRequest(path: string, init: DriveRequestOptions): Promise<Response> {
  return await connectors.proxy("google-drive", path, init);
}

async function uploadToGoogleDrive(
  videoId: string,
  filePath: string,
  contentType: string,
  format: "original" | "mp3",
): Promise<{ fileId: string; url: string } | null> {
  const bytes = await Deno.readFile(filePath);
  const boundary = `zefron_${crypto.randomUUID().replaceAll("-", "")}`;
  const extension = format === "mp3" ? "mp3" : "m4a";
  const metadata = {
    name: `zefron-${videoId}.${extension}`,
    mimeType: contentType || "audio/mp4",
    description: "Zefron cached audio",
    appProperties: { zefronVideoId: videoId },
  };
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
    JSON.stringify(metadata),
    `\r\n--${boundary}\r\nContent-Type: ${contentType || "audio/mp4"}\r\n\r\n`,
    bytes,
    `\r\n--${boundary}--\r\n`,
  ]);

  const uploadResponse = await driveRequest(
    "/upload/drive/v3/files?uploadType=multipart&fields=id,mimeType,size",
    {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    },
  );
  if (!uploadResponse.ok) return null;
  const uploaded = await uploadResponse.json();
  if (!uploaded.id) return null;

  const permissionResponse = await driveRequest(
    `/drive/v3/files/${encodeURIComponent(uploaded.id)}/permissions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "anyone", role: "reader" }),
    },
  );
  if (!permissionResponse.ok) return null;

  return {
    fileId: uploaded.id,
    url: `https://drive.usercontent.google.com/download?id=${encodeURIComponent(uploaded.id)}&export=download`,
  };
}

async function persistCachedRecord(record: CachedAudioRecord): Promise<boolean> {
  for (let attempt = 1; attempt <= STORAGE_WRITE_ATTEMPTS; attempt++) {
    const sql = await getPostgres();
    if (sql) {
      try {
        await sql`
          INSERT INTO audio_cache (
            video_id,
            format,
            url,
            title,
            content_type,
            size,
            provider,
            drive_file_id,
            telegram_file_id,
            telegram_message_id,
            created_at
          ) VALUES (
            ${record.videoId},
            ${record.format || "original"},
            ${record.url},
            ${record.title},
            ${record.contentType},
            ${record.size},
            ${record.provider},
            ${record.driveFileId || null},
            ${record.telegramFileId || null},
            ${record.telegramMessageId || null},
            ${record.createdAt}
          )
          ON CONFLICT (video_id, format) DO UPDATE SET
            url = EXCLUDED.url,
            title = EXCLUDED.title,
            content_type = EXCLUDED.content_type,
            size = EXCLUDED.size,
            provider = EXCLUDED.provider,
            drive_file_id = EXCLUDED.drive_file_id,
            telegram_file_id = EXCLUDED.telegram_file_id,
            telegram_message_id = EXCLUDED.telegram_message_id,
            created_at = EXCLUDED.created_at
        `;
        rememberCachedAudio(record.videoId, record.format || "original", record);
        return true;
      } catch (err) {
        console.warn(JSON.stringify({
          event: "audio_cache_persist_failed",
          videoId: record.videoId,
          format: record.format || "original",
          attempt,
          error: String(err).slice(0, 180),
        }));
      }
    }

    if (attempt < STORAGE_WRITE_ATTEMPTS) {
      await sleep(Math.min(10_000, 500 * 2 ** (attempt - 1)));
    }
  }
  return false;
}

function retryPendingTelegramPersistence(record: CachedAudioRecord): void {
  const key = cacheKey(record.videoId, record.format || "original");
  if (pendingTelegramPersistJobs.has(key)) return;

  const job = (async () => {
    // The first persist attempt has already used its normal retry budget.
    // Retry the database write separately, but never call Telegram again.
    for (let attempt = 1; attempt <= STORAGE_WRITE_ATTEMPTS; attempt++) {
      if (await persistCachedRecord(record)) {
        pendingTelegramRecords.delete(key);
        console.log(JSON.stringify({
          event: "audio_cache",
          state: "telegram_pending_record_persisted",
          videoId: record.videoId,
          format: record.format || "original",
          messageId: record.telegramMessageId,
          attempt,
        }));
        return;
      }
      if (attempt < STORAGE_WRITE_ATTEMPTS) {
        await sleep(Math.min(15_000, 1_000 * 2 ** (attempt - 1)));
      }
    }
  })()
    .catch((err) => {
      console.warn("Pending Telegram cache record persistence failed:", String(err).slice(0, 160));
    })
    .finally(() => {
      pendingTelegramPersistJobs.delete(key);
    });

  pendingTelegramPersistJobs.set(key, job);
}

export async function cacheAudioOnGoogleDrive(
  videoId: string,
  audio: Extract<PreparedAudioResult, { success: true }>,
  force = false,
  format: "original" | "mp3" = "original",
): Promise<CachedAudioRecord | null> {
  const jobKey = `${format}:${videoId}`;
  const active = cacheJobs.get(jobKey);
  if (active) return active;

  const job = (async () => {
    const pending = pendingTelegramRecords.get(jobKey);
    if (pending) {
      if (await persistCachedRecord(pending)) {
        pendingTelegramRecords.delete(jobKey);
      }
      // Whether or not this retry succeeded, the Telegram message already
      // exists. Never upload the same audio again.
      return pending;
    }

    const existing = await getCachedAudio(videoId, format);
    if (!force && existing) {
      // Normal cache warming should never duplicate an existing object.
      // A forced write is used only after the caller has proven that the
      // persisted object/URL is unavailable and needs replacement.
      return existing;
    }

    try {
      const telegramUpload = await queueTelegramUpload(videoId, audio);
      if (telegramUpload) {
        const record: CachedAudioRecord = {
          videoId,
          format,
          url: telegramUpload.url,
          title: audio.title,
          contentType: audio.contentType,
          size: audio.size,
          telegramFileId: telegramUpload.fileId,
          telegramMessageId: telegramUpload.messageId,
          provider: "telegram",
          createdAt: new Date(),
        };
        if (await persistCachedRecord(record)) {
          console.log(JSON.stringify({
            event: "audio_cache",
            state: "telegram_cached",
            videoId,
            format,
            messageId: telegramUpload.messageId,
          }));
          return record;
        }
        pendingTelegramRecords.set(jobKey, record);
        retryPendingTelegramPersistence(record);
        // The Telegram message already exists. Do not immediately upload the
        // same bytes again just because PostgreSQL was temporarily unavailable.
        console.warn(JSON.stringify({
          event: "audio_cache",
          state: "telegram_uploaded_storage_pending",
          videoId,
          format,
          messageId: telegramUpload.messageId,
        }));
        return record;
      }

      const uploaded = await uploadToGoogleDrive(videoId, audio.filePath, audio.contentType, format);
      if (!uploaded) {
        console.warn(`Google Drive audio upload failed: ${videoId}`);
        return null;
      }

      const record: CachedAudioRecord = {
        videoId,
        format,
        url: uploaded.url,
        title: audio.title,
        contentType: audio.contentType,
        size: audio.size,
        driveFileId: uploaded.fileId,
        provider: "google-drive",
        createdAt: new Date(),
      };
      if (await persistCachedRecord(record)) {
        console.log(`Google Drive audio cached: ${videoId}`);
        return record;
      }
      return null;
    } catch (err) {
      console.warn("Audio cache failed:", String(err).slice(0, 160));
      return null;
    }
  })().finally(() => {
    cacheJobs.delete(jobKey);
  });

  cacheJobs.set(jobKey, job);
  return job;
}