/**
 * Discovery Service
 * Trending music, radio mixes, top artists/tracks by country
 */

import { YTMusic } from "./ytmusic.ts";
import { LastFM, getTopArtists as lastfmTopArtists, getTopTracks as lastfmTopTracks } from "./lastfm.ts";

export async function getTrendingMusic(country = "United States", ytmusic?: YTMusic) {
  try {
    if (ytmusic) {
      const searchQueries = [
        `${country}n music 2026`,
        `${country}n songs`,
        `${country}n hits`,
        `popular ${country}n music`,
        `new ${country}n songs 2026`,
      ];

      const allTracks: any[] = [];
      const seenIds = new Set<string>();

      for (const query of searchQueries) {
        if (allTracks.length >= 30) break;
        const results = await ytmusic.search(query, "songs");
        if (results.results) {
          for (const t of results.results) {
            if (t.videoId && !seenIds.has(t.videoId)) {
              seenIds.add(t.videoId);
              allTracks.push({
                name: t.title,
                artist: t.artists?.map((a: any) => a.name).join(", "),
                videoId: t.videoId,
                thumbnail: t.thumbnails?.[0]?.url,
                duration: t.duration,
              });
            }
            if (allTracks.length >= 30) break;
          }
        }
      }

      if (allTracks.length > 0) {
        return { success: true, country, tracks: allTracks };
      }
    }
    return { success: false, error: "Could not fetch trending" };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

export async function getRadio(videoId: string, ytmusic: YTMusic) {
  try {
    const data = await ytmusic.getWatchPlaylist(videoId, undefined, true, false, 50);
    if (data.tracks && data.tracks.length > 0) {
      return { success: true, seedVideoId: videoId, tracks: data.tracks };
    }
    return { success: false, error: "Could not generate radio" };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

export async function getTopArtists(country?: string, limit = 20, ytmusic?: YTMusic) {
  try {
    if (country && ytmusic) {
      const searchQueries = [
        `${country}n artist`, `${country}n singer`, `${country}n rapper`,
        `${country}n musician`, `artist from ${country}`, `singer from ${country}`,
      ];

      const allArtists: any[] = [];
      const seenIds = new Set<string>();

      for (const query of searchQueries) {
        if (allArtists.length >= limit) break;
        const results = await ytmusic.search(query, "artists");
        if (results.results) {
          for (const a of results.results) {
            if (a.browseId && !seenIds.has(a.browseId)) {
              seenIds.add(a.browseId);
              allArtists.push({ name: a.title, browseId: a.browseId, thumbnail: a.thumbnails?.[0]?.url });
            }
            if (allArtists.length >= limit) break;
          }
        }
      }

      if (allArtists.length > 0) {
        return { success: true, country, artists: allArtists.slice(0, limit) };
      }
    }

    // Fallback to Last.fm global
    return await lastfmTopArtists(undefined, limit);
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

export async function getTopTracks(country?: string, limit = 20, ytmusic?: YTMusic) {
  try {
    if (country && ytmusic) {
      const searchQueries = [
        `${country}n music`, `${country}n songs`, `${country}n rap`,
        `${country}n hits 2026`, `music from ${country}`, `songs from ${country}`,
      ];

      const allTracks: any[] = [];
      const seenIds = new Set<string>();

      for (const query of searchQueries) {
        if (allTracks.length >= limit) break;
        const results = await ytmusic.search(query, "songs");
        if (results.results) {
          for (const t of results.results) {
            if (t.videoId && !seenIds.has(t.videoId)) {
              seenIds.add(t.videoId);
              allTracks.push({
                name: t.title,
                artist: t.artists?.map((a: any) => a.name).join(", "),
                videoId: t.videoId,
                thumbnail: t.thumbnails?.[0]?.url,
                duration: t.duration,
              });
            }
            if (allTracks.length >= limit) break;
          }
        }
      }

      if (allTracks.length > 0) {
        return { success: true, country, tracks: allTracks.slice(0, limit) };
      }
    }

    // Fallback to Last.fm global
    return await lastfmTopTracks(undefined, limit);
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

export async function getSimilarTracks(title: string, artist: string, limit: string, youtubeSearch: any) {
  const similar = await LastFM.getSimilarTracks(title, artist, limit);
  if ("error" in similar) return { error: (similar as any).error };

  const ytResults = await Promise.all(
    (similar as any[]).map(async (t: any) => {
      const r = await youtubeSearch.searchVideos(`${t.title} ${t.artist}`);
      return r.results[0] || null;
    })
  );
  return ytResults.filter(Boolean);
}
