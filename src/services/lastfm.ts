/**
 * Last.fm API Service
 * Artist info, track info, and similar tracks
 */

const API_KEY = "0867bcb6f36c879398969db682a7b69b";

export const LastFM = {
  API_KEY,

  async getSimilarTracks(title: string, artist: string, limit = "5") {
    const url = `https://ws.audioscrobbler.com/2.0/?method=track.getsimilar&artist=${encodeURIComponent(artist)}&track=${encodeURIComponent(title)}&api_key=${API_KEY}&limit=${limit}&format=json`;
    try {
      const response = await fetch(url);
      const data = await response.json();
      if (data?.error) return { error: data.message || "Last.fm error" };
      return (data?.similartracks?.track || [])
        .map((t: any) => ({ title: t.name, artist: t?.artist?.name }))
        .filter((t: any) => t.title && t.artist);
    } catch {
      return { error: "Failed to fetch similar tracks" };
    }
  },
};

export async function getArtistInfo(artist: string) {
  try {
    const url = `https://ws.audioscrobbler.com/2.0/?method=artist.getinfo&artist=${encodeURIComponent(artist)}&api_key=${API_KEY}&format=json`;
    const response = await fetch(url);
    const data = await response.json();
    if (data?.error) return { success: false, error: data.message };

    const a = data?.artist;
    return {
      success: true,
      name: a?.name,
      bio: a?.bio?.summary?.replace(/<[^>]*>/g, ""),
      tags: a?.tags?.tag?.map((t: any) => t.name) || [],
      similar: a?.similar?.artist?.map((s: any) => s.name) || [],
      stats: { listeners: a?.stats?.listeners, playcount: a?.stats?.playcount },
      image: a?.image?.find((i: any) => i.size === "large")?.["#text"],
    };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

export async function getTrackInfo(title: string, artist: string) {
  try {
    const url = `https://ws.audioscrobbler.com/2.0/?method=track.getInfo&artist=${encodeURIComponent(artist)}&track=${encodeURIComponent(title)}&api_key=${API_KEY}&format=json`;
    const response = await fetch(url);
    const data = await response.json();
    if (data?.error) return { success: false, error: data.message };

    const t = data?.track;
    return {
      success: true,
      name: t?.name,
      artist: t?.artist?.name,
      album: t?.album?.title,
      duration: t?.duration,
      listeners: t?.listeners,
      playcount: t?.playcount,
      tags: t?.toptags?.tag?.map((tag: any) => tag.name) || [],
      wiki: t?.wiki?.summary?.replace(/<[^>]*>/g, ""),
    };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

export async function getTopArtists(country: string | undefined, limit: number) {
  if (!country) {
    const url = `https://ws.audioscrobbler.com/2.0/?method=chart.gettopartists&api_key=${API_KEY}&limit=${limit}&format=json`;
    const response = await fetch(url);
    const data = await response.json();
    const artists = data?.artists?.artist || [];
    return {
      success: true,
      country: "Global",
      artists: artists.map((a: any) => ({
        name: a.name,
        playcount: a.playcount,
        listeners: a.listeners,
        url: a.url,
        image: a.image?.find((i: any) => i.size === "large")?.["#text"],
      })),
    };
  }
  return null; // Caller handles YTMusic-based search
}

export async function getTopTracks(country: string | undefined, limit: number) {
  if (!country) {
    const url = `https://ws.audioscrobbler.com/2.0/?method=chart.gettoptracks&api_key=${API_KEY}&limit=${limit}&format=json`;
    const response = await fetch(url);
    const data = await response.json();
    const tracks = data?.tracks?.track || [];
    return {
      success: true,
      country: "Global",
      tracks: tracks.map((t: any) => ({
        name: t.name,
        artist: t.artist?.name,
        playcount: t.playcount,
        listeners: t.listeners,
        url: t.url,
      })),
    };
  }
  return null; // Caller handles YTMusic-based search
}
