/**
 * Content Routes
 * /api/songs/:id, /api/albums/:id, /api/artists/:id, /api/playlists/:id, /api/chain/:id
 */

import { json } from "../helpers/response.ts";
import { matchRoute } from "../helpers/router.ts";
import type { YTMusic } from "../services/ytmusic.ts";
import { getSongComplete, getAlbumComplete, getArtistComplete, getFullChain } from "../services/entities.ts";

export async function handleContentRoutes(pathname: string, searchParams: URLSearchParams, ytmusic: YTMusic): Promise<Response | null> {
  let params: Record<string, string> | null;

  params = matchRoute(pathname, "/api/songs/:videoId");
  if (params) return json(await getSongComplete(params.videoId, ytmusic));

  params = matchRoute(pathname, "/api/albums/:browseId");
  if (params) return json(await getAlbumComplete(params.browseId, ytmusic));

  params = matchRoute(pathname, "/api/album/:id");
  if (params) return json(await getAlbumComplete(params.id, ytmusic));

  params = matchRoute(pathname, "/api/artists/:browseId");
  if (params) return json(await getArtistComplete(params.browseId, ytmusic));

  // /api/artist/:artistId (but NOT /api/artist/info)
  if (pathname !== "/api/artist/info") {
    params = matchRoute(pathname, "/api/artist/:artistId");
    if (params) {
      const country = searchParams.get("country") || "US";
      return json(await ytmusic.getArtistSummary(params.artistId, country));
    }
  }

  params = matchRoute(pathname, "/api/playlists/:playlistId");
  if (params) return json(await ytmusic.getPlaylist(params.playlistId));

  params = matchRoute(pathname, "/api/playlist/:id");
  if (params) return json(await ytmusic.getPlaylist(params.id));

  params = matchRoute(pathname, "/api/related/:id");
  if (params) return json({ success: true, data: await ytmusic.getRelated(params.id) });

  params = matchRoute(pathname, "/api/chain/:videoId");
  if (params) return json(await getFullChain(params.videoId, ytmusic));

  return null; // Not handled
}
