/**
 * Search Routes
 * /api/search, /api/search/suggestions, /api/yt_search
 */

import { json, error } from "../helpers/response.ts";
import { detectRegionFromIP } from "../helpers/region.ts";
import type { YTMusic } from "../services/ytmusic.ts";
import type { YouTubeSearch } from "../services/youtube-search.ts";

function dedupeSearchResults(results: any[]): any[] {
  const seen = new Set<string>();
  return results.filter((item) => {
    const videoId = String(item?.videoId || item?.id || "").trim();
    const browseId = String(item?.browseId || "").trim();
    const title = String(item?.title || item?.name || "").normalize("NFKC").trim().toLowerCase();
    const artists = Array.isArray(item?.artists)
      ? item.artists.map((artist: any) => String(artist?.name || "").trim().toLowerCase()).join("|")
      : String(item?.subtitle || "").trim().toLowerCase();
    // IDs are authoritative. The title/artist key also removes repeated
    // parser entries that arrive without an ID.
    const key = videoId
      ? `video:${videoId}`
      : browseId
        ? `browse:${browseId}`
        : `text:${title}|${artists}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function handleSearch(req: Request, searchParams: URLSearchParams, ytmusic: YTMusic, youtubeSearch: YouTubeSearch): Promise<Response> {
  const query = searchParams.get("q");
  const filter = searchParams.get("filter") || undefined;
  const continuationToken = searchParams.get("continuationToken") || undefined;
  const ignoreSpelling = searchParams.get("ignore_spelling") === "true";
  const withFallback = searchParams.get("fallback") !== "0";

  let region = searchParams.get("region") || searchParams.get("gl") || undefined;
  let language = searchParams.get("language") || searchParams.get("hl") || undefined;

  if (!region) {
    const detected = await detectRegionFromIP(req);
    if (detected) { region = detected.country; if (!language) language = detected.language; }
  }

  if (!query && !continuationToken) return error("Missing 'q' or 'continuationToken'");

  const results = await ytmusic.search(query || "", filter, continuationToken, ignoreSpelling, region, language);
  results.results = dedupeSearchResults(results.results || []);

  // Add fallback YouTube IDs for songs
  if (withFallback && filter === "songs" && results.results?.length > 0) {
    const enhanced = await Promise.all(
      // YouTube Music normally already returns a video ID. Only resolve a
      // fallback for the exceptional results that do not have one; resolving
      // the top ten songs on every search made the search feel stuck.
      results.results.filter((song: any) => !song.videoId).slice(0, 4).map(async (song: any) => {
        try {
          const ytResults = await youtubeSearch.searchVideos(`${song.title} ${song.artists?.[0]?.name || ""} official`);
          const alt = ytResults.results?.find((v: any) => v.channel?.name && !v.channel.name.includes("Topic") && v.id);
          if (alt) return { ...song, fallbackVideoId: alt.id, fallbackTitle: alt.title };
        } catch { /* skip */ }
        return song;
      })
    );
    const enhancedByKey = new Map(enhanced.map((song: any) => [
      song.videoId || song.browseId || `${song.title}|${song.artists?.map((a: any) => a.name).join("|")}`,
      song,
    ]));
    results.results = results.results.map((song: any) => {
      const key = song.videoId || song.browseId || `${song.title}|${song.artists?.map((a: any) => a.name).join("|")}`;
      return enhancedByKey.get(key) || song;
    });
  }

  return json({ query, filter, region, language, ...results });
}

export async function handleSearchSuggestions(searchParams: URLSearchParams, ytmusic: YTMusic, youtubeSearch: YouTubeSearch): Promise<Response> {
  const query = searchParams.get("q");
  if (!query) return error("Missing 'q'");
  const music = searchParams.get("music");
  const suggestions = music === "1" ? await ytmusic.getSearchSuggestions(query) : await youtubeSearch.getSuggestions(query);
  return json({ suggestions, source: music === "1" ? "youtube_music" : "youtube" });
}

export async function handleYTSearch(searchParams: URLSearchParams, youtubeSearch: YouTubeSearch): Promise<Response> {
  const query = searchParams.get("q");
  const filter = searchParams.get("filter") || "all";
  const continuationToken = searchParams.get("continuationToken") || undefined;

  if (!query && !continuationToken) return error("Missing 'q' or 'continuationToken'");

  const results: unknown[] = [];
  let nextToken: string | null = null;

  if (continuationToken) {
    if (filter === "videos") { const r = await youtubeSearch.searchVideos(null, continuationToken); results.push(...r.results); nextToken = r.continuationToken; }
    else if (filter === "channels") { const r = await youtubeSearch.searchChannels(null, continuationToken); results.push(...r.results); nextToken = r.continuationToken; }
    else if (filter === "playlists") { const r = await youtubeSearch.searchPlaylists(null, continuationToken); results.push(...r.results); nextToken = r.continuationToken; }
  } else if (query) {
    if (filter === "videos" || filter === "all") { const r = await youtubeSearch.searchVideos(query); results.push(...r.results); nextToken = r.continuationToken; }
    if (filter === "channels" || filter === "all") { const r = await youtubeSearch.searchChannels(query); results.push(...r.results); if (!nextToken) nextToken = r.continuationToken; }
    if (filter === "playlists" || filter === "all") { const r = await youtubeSearch.searchPlaylists(query); results.push(...r.results); if (!nextToken) nextToken = r.continuationToken; }
  }

  return json({ filter, query, results, continuationToken: nextToken });
}
