/**
 * Info Routes
 * /api/lyrics, /api/artist/info, /api/track/info
 */

import { json, error } from "../helpers/response.ts";
import { getLyrics } from "../services/lyrics.ts";
import { getArtistInfo, getTrackInfo } from "../services/lastfm.ts";

export async function handleInfoRoutes(pathname: string, searchParams: URLSearchParams): Promise<Response | null> {
  if (pathname === "/api/lyrics") {
    const title = searchParams.get("title"), artist = searchParams.get("artist");
    if (!title || !artist) return error("Missing title and artist");
    return json(await getLyrics(title, artist, searchParams.get("duration") ? parseInt(searchParams.get("duration")!) : undefined));
  }

  if (pathname === "/api/artist/info") {
    const artist = searchParams.get("artist");
    if (!artist) return error("Missing artist");
    return json(await getArtistInfo(artist));
  }

  if (pathname === "/api/track/info") {
    const title = searchParams.get("title"), artist = searchParams.get("artist");
    if (!title || !artist) return error("Missing title and artist");
    return json(await getTrackInfo(title, artist));
  }

  return null;
}
