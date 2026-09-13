# Zefron API on Replit

## Run

The project uses Deno 2 and runs as a single web application:

```bash
PORT=5000 deno task start:local
```

The Replit workflow named `Start application` runs this local-preview command automatically and exposes the API and built-in web player in Preview. On a VPS, use `deno task start` so the app connects to the VPS PostgreSQL service instead of trying to create a local preview database.

## Development

For local development with automatic reloads:

```bash
PORT=5000 deno task dev
```

The health endpoint is available at `/health`.

## Telegram audio cache

Set these values through Replit Secrets/environment variables rather than
committing them:

- `TELEGRAM_BOT_TOKEN` — bot token
- `TELEGRAM_OUTPUT_BOT_TOKEN` — optional separate bot token for user-facing `/song` delivery
- `DATABASE_URL` — PostgreSQL connection URI used for the persistent audio cache
- `TELEGRAM_CACHE_CHANNEL_ID` — channel ID where cached audio is uploaded
- `TELEGRAM_ADMIN_CHAT_ID` — optional chat/user ID allowed to run `/reload`
- `TELEGRAM_UPLOAD_DELAY_MS` — optional delay between channel uploads; defaults to 1100ms
- `TELEGRAM_UPLOAD_RETRIES` — optional retry count for rate limits/transient Telegram errors; defaults to 4
- `AUDIO_CACHE_WRITE_ATTEMPTS` — optional PostgreSQL record-write retries after Telegram/Drive upload; defaults to 4
- `AUDIO_MEMORY_CACHE_TTL_MS` — optional in-process cache lifetime for fast repeated downloads; defaults to 5 minutes
- `TELEGRAM_URL_REFRESH_BUDGET_MS` — maximum cache-hit wait for a fresh Telegram URL; defaults to 1500ms
- `TELEGRAM_URL_REFRESH_FALLBACK_BUDGET_MS` — maximum wait to refresh Telegram after a cached media URL fails; defaults to 10000ms
- `MEDIA_BODY_TIMEOUT_MS` — maximum time allowed to spool a provider response body; defaults to 120000ms
- `MEDIA_PROVIDER_COOLDOWN_MS` — cooldown after a provider returns media 403 responses; defaults to 120000ms
- `DISABLED_MEDIA_PROVIDERS` — comma-separated provider hosts to skip for media; defaults to `https://yt.omada.cafe`
- `MP3_CACHE_ATTEMPTS` — optional background preparation/upload attempts; defaults to 5
- `MP3_CACHE_RETRY_DELAY_MS` — optional initial delay between background retries; defaults to 5000ms
- `MP3_CACHE_CONCURRENCY` — optional number of background cache workers; defaults to 6
- `MP3_CACHE_QUEUE_LIMIT` — optional burst queue size for background cache jobs; defaults to 500
- `FFMPEG_QUEUE_LIMIT` / `YTDLP_QUEUE_LIMIT` — optional media-worker queue sizes; defaults to 250 each

The server uploads warmed audio to Telegram, stores its stable `file_id` and
`message_id` with the YouTube video ID in PostgreSQL (`audio_cache`), and
re-resolves the Telegram file URL on cache hits. The input bot command `/reload <video ID or URL>`
refreshes the cache entry. The output bot accepts `/song <video ID or URL>` and
uses `copyMessage` from the storage channel. The configured admin chat can use
`/ping`, `/status`, and `/restart` to monitor and restart bot polling.

The local preview startup runs `scripts/start-postgres.sh`, which starts the
workspace PostgreSQL service and applies `scripts/audio-cache.sql` before the
API starts. For a separately managed production database, apply the same
schema through that database's normal schema-release flow.