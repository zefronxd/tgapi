CREATE TABLE IF NOT EXISTS audio_cache (
  video_id TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'original'
    CHECK (format IN ('original', 'mp3')),
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  content_type TEXT NOT NULL DEFAULT 'audio/mpeg',
  size BIGINT NOT NULL DEFAULT 0,
  provider TEXT NOT NULL
    CHECK (provider IN ('google-drive', 'telegram')),
  drive_file_id TEXT,
  telegram_file_id TEXT,
  telegram_message_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (video_id, format)
);

-- Older imported databases may have been created before the composite
-- primary key was added. Keep the newest record for each logical cache key
-- before enforcing the constraint used by the upsert path.
DELETE FROM audio_cache older
USING audio_cache newer
WHERE older.video_id = newer.video_id
  AND older.format = newer.format
  AND (
    older.created_at < newer.created_at
    OR (older.created_at = newer.created_at AND older.ctid < newer.ctid)
  );

CREATE UNIQUE INDEX IF NOT EXISTS audio_cache_video_format_unique
  ON audio_cache (video_id, format);