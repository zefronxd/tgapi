<div align="center">
  <img src="assets/ZefronLogo.png" alt="Zefron API" width="120">
  <h1>Zefron API</h1>
  <p>Music API for YouTube Music, Lyrics & Streaming</p>
  <p><a href="https://verome-api.deno.dev/">Live</a></p>
</div>

---

## Features

- Search songs, albums, artists with fallback video IDs
- Synced lyrics (LRC format) via LRCLib
- Audio streaming via Piped/Invidious proxies
- MP3 audio downloads with track filenames via the built-in download endpoint
- Fast direct audio downloads through YouTube InnerTube with cookie support
- Radio mixes from any song
- Trending music & top artists by country
- Artist/track info from Last.fm
- Built-in web player with YouTube IFrame API
- Auto region detection from IP

## Quick Start

```bash
deno task start
```

Server runs at `http://localhost:8000`

## Development

```bash
deno task dev
```

## Project Structure

```
main.ts                    Entry point (Deno.serve)
ui.ts                      Web UI HTML
assets/                    Static assets (logo)
src/
├── helpers/
│   ├── response.ts        JSON/error helpers, CORS
│   ├── region.ts          IP-based region detection
│   └── router.ts          Route pattern matching
├── services/
│   ├── ytmusic.ts         YouTube Music API client
│   ├── ytmusic-parser.ts  YT Music response parsers
│   ├── youtube-search.ts  YouTube Search (web scraping)
│   ├── lastfm.ts          Last.fm API
│   ├── streaming.ts       Piped/Invidious stream fetching
│   ├── lyrics.ts          LRCLib lyrics
│   ├── entities.ts        Combined entity fetchers
│   └── discovery.ts       Trending, radio, top charts
└── routes/
    ├── search.ts          /api/search, /api/yt_search
    ├── content.ts         /api/songs, /api/albums, /api/artists
    ├── discover.ts        /api/charts, /api/trending, /api/radio
    ├── stream.ts          /api/stream, /api/proxy
    ├── info.ts            /api/lyrics, /api/artist/info
    └── feed.ts            /api/feed/*
```

## API Endpoints

### Search
| Endpoint | Description |
|----------|-------------|
| `/api/search?q=&filter=` | Search YouTube Music |
| `/api/yt_search?q=&filter=` | Search YouTube |
| `/api/search/suggestions?q=` | Autocomplete |

### Content
| Endpoint | Description |
|----------|-------------|
| `/api/songs/:videoId` | Song + artist/album links |
| `/api/albums/:browseId` | Album + tracks |
| `/api/artists/:browseId` | Artist + discography |
| `/api/playlists/:playlistId` | Playlist tracks |
| `/api/chain/:videoId` | Song → Artist → Albums |

### Discovery
| Endpoint | Description |
|----------|-------------|
| `/api/related/:videoId` | Related songs |
| `/api/radio?videoId=` | Radio mix |
| `/api/similar?title=&artist=` | Similar tracks |
| `/api/charts?country=` | Charts |
| `/api/trending?country=` | Trending |
| `/api/moods` | Mood categories |
| `/api/top/artists?country=` | Top artists |
| `/api/top/tracks?country=` | Top tracks |

### Streaming & Lyrics
| Endpoint | Description |
|----------|-------------|
| `/api/stream?id=` | Audio stream URLs |
| `/api/download/warm?id=` | Start fast audio preparation before downloading |
| `/api/download?id=<video-id-or-url>&format=mp3&filename=` | Download a small 64 kbps MP3 (usually 2–3 MB) |
| `/api/download?id=<video-id-or-url>&format=original&filename=` | Fast direct audio handoff, usually M4A |

When `DATABASE_URL` is configured, warmed MP3 files are uploaded to the
configured Telegram cache channel when `TELEGRAM_BOT_TOKEN` and
`TELEGRAM_CACHE_CHANNEL_ID` are set. PostgreSQL stores the YouTube video ID,
format, and Telegram `file_id`; later stream/download requests resolve a fresh
Telegram download URL instead of converting the source again. Google Drive
remains as a fallback for the existing original-audio cache.

The optional Telegram bot accepts `/reload <YouTube video ID or URL>`. Set
`TELEGRAM_ADMIN_CHAT_ID` to restrict reload commands to one Telegram chat/user;
without it, reload commands are accepted only in the configured cache channel.
| `/api/proxy?url=` | Audio proxy (CORS) |
| `/api/lyrics?title=&artist=` | Synced lyrics |

### Info
| Endpoint | Description |
|----------|-------------|
| `/api/artist/info?artist=` | Artist bio |
| `/api/track/info?title=&artist=` | Track info |

## Deploy

For authenticated YouTube downloads, set `YTDLP_COOKIE_FILE` to a private
Netscape-format cookie file. If it is not set, the server automatically uses
the newest Netscape cookie file in `attached_assets/`.

Uses the new [Deno Deploy](https://console.deno.com) platform (not Deploy Classic).

```bash
deno task deploy
```

> This project uses `Deno.serve()` as required by the new Deno Deploy.
> Deploy Classic (dash.deno.com) shuts down July 20, 2026.

## License

MIT
