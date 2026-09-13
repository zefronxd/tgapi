/**
 * Lyrics Service
 * Fetches synced lyrics from LRCLib (free, no API key)
 */

export async function getLyrics(title: string, artist: string, duration?: number) {
  try {
    let url = `https://lrclib.net/api/get?track_name=${encodeURIComponent(title)}&artist_name=${encodeURIComponent(artist)}`;
    if (duration) url += `&duration=${duration}`;

    let response = await fetch(url);
    let data = await response.json();

    // Fallback to search if no exact match
    if (!data || data.statusCode === 404) {
      const searchUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(`${title} ${artist}`)}`;
      response = await fetch(searchUrl);
      const results = await response.json();
      if (Array.isArray(results) && results.length > 0) {
        data = results[0];
      }
    }

    if (!data || data.statusCode) {
      return { success: false, error: "Lyrics not found" };
    }

    return {
      success: true,
      trackName: data.trackName,
      artistName: data.artistName,
      albumName: data.albumName,
      duration: data.duration,
      plainLyrics: data.plainLyrics,
      syncedLyrics: data.syncedLyrics,
    };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}
