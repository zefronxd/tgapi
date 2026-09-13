/**
 * Discovery Routes
 * /api/charts, /api/moods, /api/trending, /api/radio, /api/similar, /api/top/*
 */

import { json, error } from "../helpers/response.ts";
import { matchRoute } from "../helpers/router.ts";
import type { YTMusic } from "../services/ytmusic.ts";
import type { YouTubeSearch } from "../services/youtube-search.ts";
import { getTrendingMusic, getRadio, getTopArtists, getTopTracks, getSimilarTracks } from "../services/discovery.ts";

export async function handleDiscoverRoutes(pathname: string, searchParams: URLSearchParams, ytmusic: YTMusic, youtubeSearch: YouTubeSearch): Promise<Response | null> {
  if (pathname === "/api/charts") {
    return json(await ytmusic.getCharts(searchParams.get("country") || undefined));
  }

  if (pathname === "/api/moods") {
    return json(await ytmusic.getMoodCategories());
  }

  const moodParams = matchRoute(pathname, "/api/moods/:categoryId");
  if (moodParams) {
    return json(await ytmusic.getMoodPlaylists(moodParams.categoryId));
  }

  if (pathname === "/api/watch_playlist") {
    const videoId = searchParams.get("videoId") || undefined;
    const playlistId = searchParams.get("playlistId") || undefined;
    if (!videoId && !playlistId) return error("Provide videoId or playlistId");
    return json(await ytmusic.getWatchPlaylist(
      videoId, playlistId,
      searchParams.get("radio") === "true",
      searchParams.get("shuffle") === "true",
      parseInt(searchParams.get("limit") || "25"),
    ));
  }

  if (pathname === "/api/trending") {
    return json(await getTrendingMusic(searchParams.get("country") || "United States", ytmusic));
  }

  if (pathname === "/api/radio") {
    const videoId = searchParams.get("videoId");
    if (!videoId) return error("Missing videoId");
    return json(await getRadio(videoId, ytmusic));
  }

  if (pathname === "/api/similar") {
    const title = searchParams.get("title"), artist = searchParams.get("artist");
    if (!title || !artist) return error("Missing title or artist");
    const result = await getSimilarTracks(title, artist, searchParams.get("limit") || "5", youtubeSearch);
    if ("error" in result) return json({ error: (result as any).error }, 500);
    return json(result);
  }

  if (pathname === "/api/top/artists") {
    return json(await getTopArtists(searchParams.get("country") || undefined, parseInt(searchParams.get("limit") || "20"), ytmusic));
  }

  if (pathname === "/api/top/tracks") {
    return json(await getTopTracks(searchParams.get("country") || undefined, parseInt(searchParams.get("limit") || "20"), ytmusic));
  }

  return null;
}
