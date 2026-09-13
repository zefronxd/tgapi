---
name: Audio source validation
description: Reliability constraints for proxied third-party audio URLs.
---

Third-party media URLs may be signed for the provider's egress IP and return 403 when fetched from the app server. A metadata API succeeding does not guarantee its media URL is usable. Stale authenticated YouTube cookies can also make otherwise-public player requests fail, and HLS playlists can be mislabeled as audio.

**Why:** Metadata and media delivery can be handled by different upstream systems, with different IP, expiry, and access rules; invalid auth headers can poison public fallback paths.

**How to apply:** Prefer unauthenticated resolution, retry with cookies for protected media, validate candidate responses/content before returning them, reject HLS playlists as audio, and keep provider fallbacks behind the server proxy.

In this Replit environment, YouTube media URLs and yt-dlp clients can both be rejected for bot verification even when search and metadata work. A server-side MP3 conversion fallback can still produce a valid audio/mpeg response, so validate the downloaded bytes rather than trusting the resolver status or filename.

For fast audio delivery, handing the short-lived M4A URL directly to the browser avoids proxying the file through Replit, but upstream preparation and bandwidth still dominate first-download latency; this is an optimization, not a 2–4 second guarantee.

Persisted Telegram cache records should fall back to their last-known file URL when a transient `getFile` refresh fails; otherwise a valid cache is incorrectly treated as a miss after a restart.

**Why:** Telegram refresh calls and media delivery can fail independently of the stored Mongo record, and re-transcoding defeats the purpose of the persistent cache.

**How to apply:** Refresh Telegram file URLs when possible, but retain a stored URL as a bounded fallback and retry refreshes on later cache hits.

Provider header-resolution timeouts must not be reused for the media response body; a signed audio response can arrive quickly while FFmpeg still needs longer to consume it.

**Why:** Aborting the fetch signal after headers cancels the body pipe and can surface as an uncaught Deno `Interrupted` error that terminates the service.

**How to apply:** Keep provider lookup bounded, but give media-body reads and FFmpeg a separate longer timeout controlled by environment settings.

When converting remote media with FFmpeg, spool the response body to a temporary file before starting FFmpeg instead of piping the fetch body directly into the subprocess.

**Why:** Even with a longer media timeout, upstream cancellation and subprocess shutdown can race on a live pipe and produce repeated `Interrupted: operation canceled` failures under concurrency.

**How to apply:** Validate and write the response first, run FFmpeg from the completed temp file, and remove the source file in a finally block.

When spooling a fetch body into a Deno file with `pipeTo`, use `preventClose: true` if the file will be closed explicitly afterward.

**Why:** `pipeTo` closes the destination by default; explicitly closing the same Deno file then raises `BadResource: Bad resource ID` after a successful transfer and falsely marks preparation as failed.

**How to apply:** Close the destination exactly once in the surrounding `finally` block, then continue with size validation and FFmpeg conversion.

When racing multiple provider candidates, abort every losing request as soon as one valid response wins.

**Why:** `Promise.any` does not cancel its losers; under concurrent song requests, abandoned fetches and response bodies can exhaust Deno resources and surface as `BadResource: Bad resource ID`.

**How to apply:** Use per-candidate abort controllers and timers for Piped, Invidious, and media-source races, preserving only the winning response for conversion.

Production VPS code is not updated by restarting the Replit workflow; a VPS restart only reloads the source already deployed on that VPS.

**Why:** Replit and the VPS run separate working copies, so a successful local type-check or workflow restart does not prove the production service contains the latest reliability fix.

**How to apply:** After source changes, deploy/sync the VPS copy first, then restart the systemd service and verify the running journal for the changed behavior.