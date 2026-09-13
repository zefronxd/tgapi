/**
 * Entity Helpers
 * Complete data fetchers that combine multiple API calls
 * (song complete, album complete, artist complete, full chain)
 */

import { YTMusic } from "./ytmusic.ts";

export async function getSongComplete(videoId: string, ytmusic: YTMusic) {
  const song = await ytmusic.getSong(videoId);
  if (!song?.videoId) return { success: false, error: "Song not found" };

  const searchResults = await ytmusic.search(`${song.title} ${song.author}`, "songs");
  const match = searchResults.results?.find((r: any) => r.videoId === videoId);

  return {
    success: true,
    song: { videoId: song.videoId, title: song.title, duration: song.lengthSeconds, thumbnail: song.thumbnail },
    artist: { name: song.author, browseId: match?.artists?.[0]?.id || null },
    album: match?.browseId?.startsWith("MPRE") ? { browseId: match.browseId } : null,
  };
}

export async function getAlbumComplete(browseId: string, ytmusic: YTMusic) {
  const album = await ytmusic.getAlbum(browseId);
  if (!album?.title) return { success: false, error: "Album not found" };

  let artistBrowseId = null;
  if (album.artist) {
    const artistSearch = await ytmusic.search(album.artist, "artists");
    artistBrowseId = artistSearch.results?.[0]?.browseId || null;
  }

  return {
    success: true,
    album: { browseId: album.browseId, title: album.title, year: album.year, thumbnail: album.thumbnail, trackCount: album.trackCount },
    artist: { name: album.artist, browseId: artistBrowseId },
    tracks: album.tracks.map((t: any, i: number) => ({
      videoId: t.videoId, title: t.title, duration: t.duration, trackNumber: i + 1,
    })),
  };
}

export async function getArtistComplete(browseId: string, ytmusic: YTMusic) {
  const artist = await ytmusic.getArtist(browseId);
  if (!artist?.name) return { success: false, error: "Artist not found" };

  return {
    success: true,
    artist: { browseId: artist.browseId, name: artist.name, description: artist.description, thumbnail: artist.thumbnail, subscribers: artist.subscribers },
    topSongs: artist.topSongs.map((s: any) => ({ videoId: s.videoId, title: s.title, thumbnail: s.thumbnails?.[0]?.url })),
    albums: artist.albums.map((a: any) => ({ browseId: a.browseId, title: a.title, year: a.subtitle?.match(/\d{4}/)?.[0] || null, thumbnail: a.thumbnails?.[0]?.url })),
    singles: artist.singles.map((s: any) => ({ browseId: s.browseId, title: s.title, year: s.subtitle?.match(/\d{4}/)?.[0] || null, thumbnail: s.thumbnails?.[0]?.url })),
  };
}

export async function getFullChain(videoId: string, ytmusic: YTMusic) {
  const songData = await getSongComplete(videoId, ytmusic);
  if (!songData.success) return songData;

  const result: any = { success: true, song: songData.song, artist: songData.artist };

  if (songData.artist?.browseId) {
    const artistData = await getArtistComplete(songData.artist.browseId, ytmusic);
    if (artistData.success) {
      result.artistDetails = { description: (artistData as any).artist.description, subscribers: (artistData as any).artist.subscribers, thumbnail: (artistData as any).artist.thumbnail };
      result.discography = { albums: (artistData as any).albums, singles: (artistData as any).singles };
      result.otherSongs = (artistData as any).topSongs.filter((s: any) => s.videoId !== videoId).slice(0, 5);
    }
  }

  return result;
}
