/**
 * Zefron API - Entry Point
 * Music API for YouTube Music, Lyrics & Streaming
 *
 * Run: deno task start
 * Dev: deno task dev
 * Deploy: deno task deploy
 */

import { YTMusic } from "./src/services/ytmusic.ts";
import { YouTubeSearch } from "./src/services/youtube-search.ts";
import { json, corsHeaders } from "./src/helpers/response.ts";
import { html as uiHtml } from "./ui.ts";

// Routes
import { handleSearch, handleSearchSuggestions, handleYTSearch } from "./src/routes/search.ts";
import { handleContentRoutes } from "./src/routes/content.ts";
import { handleDiscoverRoutes } from "./src/routes/discover.ts";
import {
  handleStream,
  handleDownload,
  handleWarmDownload,
  handleProxy,
  handleMusicFind,
} from "./src/routes/stream.ts";
import { getStreamingMetrics } from "./src/services/streaming.ts";
import { handleInfoRoutes } from "./src/routes/info.ts";
import { handleFeedRoutes } from "./src/routes/feed.ts";
import { startTelegramBot } from "./src/services/telegram-bot.ts";

// ─── Service Instances ──────────────────────────────────────

const ytmusic = new YTMusic();
const youtubeSearch = new YouTubeSearch();

// ─── Request Handler ────────────────────────────────────────

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const { pathname, searchParams } = url;

  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Root - UI
    if (pathname === "/") {
      return new Response(uiHtml, { headers: { "Content-Type": "text/html", ...corsHeaders } });
    }

    // Logo
    if (pathname === "/assets/logo.png" || pathname === "/assets/Logo.png" || pathname === "/assets/ZefronLogo.png") {
      try {
        const logoPath = new URL("./assets/ZefronLogo.png", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
        const logo = await Deno.readFile(logoPath);
        return new Response(logo, { headers: { "Content-Type": "image/png", ...corsHeaders } });
      } catch {
        return new Response("Logo not found", { status: 404 });
      }
    }

    if (pathname === "/favicon.ico") return new Response(null, { status: 204 });
    if (pathname === "/health") return json({ status: "ok", version: "2.0.0" });

    // ─── Search ─────────────────────────────────────────────
    if (pathname === "/api/search") return await handleSearch(req, searchParams, ytmusic, youtubeSearch);
    if (pathname === "/api/search/suggestions") return await handleSearchSuggestions(searchParams, ytmusic, youtubeSearch);
    if (pathname === "/api/yt_search") return await handleYTSearch(searchParams, youtubeSearch);

    // ─── Content (entities) ─────────────────────────────────
    const contentResponse = await handleContentRoutes(pathname, searchParams, ytmusic);
    if (contentResponse) return contentResponse;

    // ─── Discovery ──────────────────────────────────────────
    const discoverResponse = await handleDiscoverRoutes(pathname, searchParams, ytmusic, youtubeSearch);
    if (discoverResponse) return discoverResponse;

    // ─── Streaming ──────────────────────────────────────────
    if (pathname === "/api/music/find") return await handleMusicFind(searchParams, ytmusic);
    if (pathname === "/api/stream") return await handleStream(searchParams);
    if (pathname === "/api/download/warm") return handleWarmDownload(searchParams);
    if (pathname === "/api/download/metrics") return json(getStreamingMetrics());
    if (pathname === "/api/download") return await handleDownload(searchParams, req);
    if (pathname === "/api/proxy") return await handleProxy(searchParams, req);

    // ─── Info (lyrics, artist/track info) ───────────────────
    const infoResponse = await handleInfoRoutes(pathname, searchParams);
    if (infoResponse) return infoResponse;

    // ─── Feed ───────────────────────────────────────────────
    const feedResponse = await handleFeedRoutes(pathname, searchParams);
    if (feedResponse) return feedResponse;

    // ─── 404 ────────────────────────────────────────────────
    return json({ error: "Route not found", path: pathname }, 404);

  } catch (err) {
    console.error("Request error:", err);
    return json({ error: "Internal server error" }, 500);
  }
}

// ─── Start Server ───────────────────────────────────────────

const PORT = parseInt(Deno.env.get("PORT") || "8000");
console.log(`Zefron API v2.0.0 running on http://localhost:${PORT}`);
Deno.serve({ port: PORT }, handler);
startTelegramBot();
