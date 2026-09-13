---
name: Telegram cache delivery
description: Keep Telegram bot credentials out of public API media responses.
---

Cached Telegram media must be fetched server-side and streamed through the API; public stream metadata should reference the app's download route rather than a Telegram file URL.

**Why:** Telegram file URLs contain a bot token, and some API clients do not follow redirects reliably even though Telegram bot delivery works.

**How to apply:** Keep stable Telegram file/message identifiers in storage, refresh the file URL server-side, proxy range requests and audio headers through the download endpoint, and never expose the Telegram URL in `/api/stream` responses.