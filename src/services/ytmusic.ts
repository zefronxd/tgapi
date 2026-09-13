/**
 * YouTube Music API - Core class
 * Handles search, browse, and player requests to YouTube Music's internal API
 */

import { parseSearchResults, parseSuggestions, parseMusicItem, parseTwoRowItem } from "./ytmusic-parser.ts";

export class YTMusic {
  private baseURL = "https://music.youtube.com/youtubei/v1";
  private apiKey = "AIzaSyC9XL3ZjWjXClIX1FmUxJq--EohcD4_oSs";
  private context = {
    client: {
      hl: "en",
      gl: "US",
      clientName: "WEB_REMIX",
      clientVersion: "1.20251015.03.00",
      platform: "DESKTOP",
      utcOffsetMinutes: 0,
    },
  };

  // ─── Search ───────────────────────────────────────────────

  async search(query: string, filter?: string, continuationToken?: string, _ignoreSpelling = false, region?: string, language?: string) {
    const normalizedQuery = query.normalize("NFC");
    const filterParams = this.getFilterParams(filter);

    const params: any = continuationToken
      ? { continuation: continuationToken }
      : filterParams
        ? { query: normalizedQuery, params: filterParams }
        : { query: normalizedQuery };

    const context = (region || language)
      ? { client: { ...this.context.client, gl: region || this.context.client.gl, hl: language || this.context.client.hl } }
      : this.context;

    const data = await this.makeRequestWithContext("search", params, context);
    return parseSearchResults(data);
  }

  async getSearchSuggestions(query: string): Promise<string[]> {
    const data = await this.makeRequest("music/get_search_suggestions", { input: query.normalize("NFC") });
    return parseSuggestions(data);
  }

  // ─── Player ───────────────────────────────────────────────

  async getSong(videoId: string) {
    const data = await this.makeRequest("player", { videoId });
    const details = data?.videoDetails || {};
    return {
      videoId: details.videoId,
      title: details.title,
      author: details.author,
      lengthSeconds: details.lengthSeconds,
      thumbnail: details.thumbnail?.thumbnails?.[0]?.url,
    };
  }

  // ─── Browse: Album ────────────────────────────────────────

  async getAlbum(browseId: string) {
    const data = await this.makeRequest("browse", { browseId });

    const singleColumn = data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents;
    const twoColumnPrimary = data?.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents;
    const twoColumnSecondary = data?.contents?.twoColumnBrowseResultsRenderer?.secondaryContents?.sectionListRenderer?.contents;

    let title = "", artist = "", thumbnail = "", year = "";

    const oldHeader = data?.header?.musicDetailHeaderRenderer ||
      data?.header?.musicImmersiveHeaderRenderer ||
      data?.header?.musicVisualHeaderRenderer;

    if (oldHeader) {
      title = oldHeader.title?.runs?.[0]?.text;
      const subtitleRuns = oldHeader.subtitle?.runs || oldHeader.straplineTextOne?.runs || [];
      artist = subtitleRuns.find((r: any) => r.navigationEndpoint)?.text || subtitleRuns[0]?.text;
      thumbnail = oldHeader.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails?.slice(-1)[0]?.url ||
        oldHeader.thumbnail?.croppedSquareThumbnailRenderer?.thumbnail?.thumbnails?.slice(-1)[0]?.url;
    }

    const primaryContents = twoColumnPrimary || singleColumn || [];
    for (const section of primaryContents) {
      if (section.musicResponsiveHeaderRenderer) {
        const h = section.musicResponsiveHeaderRenderer;
        title = h.title?.runs?.[0]?.text || title;
        const subtitleRuns = h.straplineTextOne?.runs || h.subtitle?.runs || [];
        artist = subtitleRuns.find((r: any) => r.navigationEndpoint)?.text || subtitleRuns[0]?.text || artist;
        thumbnail = h.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails?.slice(-1)[0]?.url || thumbnail;
        for (const run of (h.subtitle?.runs || [])) {
          const yearMatch = run.text?.match(/\d{4}/);
          if (yearMatch) year = yearMatch[0];
        }
      }
      if (section.musicDescriptionShelfRenderer) {
        const subHeader = section.musicDescriptionShelfRenderer.subheader?.runs?.[0]?.text || "";
        const yearMatch = subHeader.match(/\d{4}/);
        if (yearMatch && !year) year = yearMatch[0];
      }
    }

    const trackContents = twoColumnSecondary || singleColumn || [];
    const tracks: any[] = [];
    for (const section of trackContents) {
      for (const item of (section.musicShelfRenderer?.contents || [])) {
        const parsed = parseMusicItem(item.musicResponsiveListItemRenderer);
        if (parsed) tracks.push(parsed);
      }
    }

    return { browseId, title, artist, thumbnail, year, trackCount: tracks.length, tracks };
  }

  // ─── Browse: Artist ───────────────────────────────────────

  async getArtist(browseId: string) {
    const data = await this.makeRequest("browse", { browseId });
    const header = data?.header?.musicImmersiveHeaderRenderer || data?.header?.musicVisualHeaderRenderer || {};
    const contents = data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];

    const topSongs: any[] = [], albums: any[] = [], singles: any[] = [], videos: any[] = [];

    for (const section of contents) {
      const shelf = section.musicShelfRenderer;
      const carousel = section.musicCarouselShelfRenderer;

      if (shelf) {
        const t = shelf.title?.runs?.[0]?.text?.toLowerCase() || "";
        if (t.includes("song")) {
          for (const item of (shelf.contents || [])) {
            const parsed = parseMusicItem(item.musicResponsiveListItemRenderer);
            if (parsed) topSongs.push(parsed);
          }
        }
      }

      if (carousel) {
        const t = carousel.header?.musicCarouselShelfBasicHeaderRenderer?.title?.runs?.[0]?.text?.toLowerCase() || "";
        const items = (carousel.contents || []).map((item: any) => parseTwoRowItem(item.musicTwoRowItemRenderer)).filter(Boolean);
        if (t.includes("album")) albums.push(...items);
        else if (t.includes("single")) singles.push(...items);
        else if (t.includes("video")) videos.push(...items);
      }
    }

    return {
      browseId,
      name: header.title?.runs?.[0]?.text,
      description: header.description?.runs?.[0]?.text,
      thumbnail: header.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails?.slice(-1)[0]?.url,
      subscribers: header.subscriptionButton?.subscribeButtonRenderer?.subscriberCountText?.runs?.[0]?.text,
      topSongs, albums, singles, videos,
    };
  }

  async getArtistSummary(artistId: string, country = "US") {
    const url = "https://music.youtube.com/youtubei/v1/browse?prettyPrint=false";
    const body = { browseId: artistId, context: { client: { ...this.context.client, gl: country } } };

    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json();

    const header = data?.header?.musicImmersiveHeaderRenderer || data?.header?.musicVisualHeaderRenderer;
    const contents = data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];

    let playlistId = null;
    for (const item of contents) {
      if (item.musicShelfRenderer?.title?.runs?.[0]?.text === "Top songs") {
        playlistId = item.musicShelfRenderer.contents?.[0]?.musicResponsiveListItemRenderer?.flexColumns?.[0]
          ?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.navigationEndpoint?.watchEndpoint?.playlistId;
        break;
      }
    }

    let recommendedArtists = null;
    for (const item of contents) {
      const headerTitle = item.musicCarouselShelfRenderer?.header?.musicCarouselShelfBasicHeaderRenderer?.title?.runs?.[0]?.text;
      if (headerTitle === "Fans might also like") {
        recommendedArtists = (item.musicCarouselShelfRenderer.contents || []).map((it: any) => ({
          name: it.musicTwoRowItemRenderer?.title?.runs?.[0]?.text,
          browseId: it.musicTwoRowItemRenderer?.navigationEndpoint?.browseEndpoint?.browseId,
          thumbnail: it.musicTwoRowItemRenderer?.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails?.[0]?.url,
        }));
        break;
      }
    }

    return {
      artistName: header?.title?.runs?.[0]?.text,
      artistAvatar: header?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails?.[0]?.url,
      playlistId,
      recommendedArtists,
    };
  }

  // ─── Browse: Playlist ─────────────────────────────────────

  async getPlaylist(playlistId: string) {
    const browseId = `VL${playlistId.replace(/^VL/, "")}`;
    const data = await this.makeRequest("browse", { browseId });

    const primaryContents = data?.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
    let title = "", author = "", description = "", thumbnail = "";

    for (const section of primaryContents) {
      if (section.musicResponsiveHeaderRenderer) {
        const h = section.musicResponsiveHeaderRenderer;
        title = h.title?.runs?.[0]?.text || "";
        const subtitleRuns = h.straplineTextOne?.runs || [];
        author = subtitleRuns.find((r: any) => r.navigationEndpoint)?.text || subtitleRuns[0]?.text || "";
        description = h.description?.musicDescriptionShelfRenderer?.description?.runs?.[0]?.text || "";
        thumbnail = h.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails?.slice(-1)[0]?.url || "";
      }
    }

    const oldHeader = data?.header?.musicDetailHeaderRenderer ||
      data?.header?.musicEditablePlaylistDetailHeaderRenderer?.header?.musicDetailHeaderRenderer;
    if (oldHeader && !title) {
      title = oldHeader.title?.runs?.[0]?.text || "";
      const subtitleRuns = oldHeader.subtitle?.runs || [];
      author = subtitleRuns.find((r: any) => r.navigationEndpoint)?.text || subtitleRuns[0]?.text || "";
      thumbnail = oldHeader.thumbnail?.croppedSquareThumbnailRenderer?.thumbnail?.thumbnails?.slice(-1)[0]?.url ||
        oldHeader.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails?.slice(-1)[0]?.url || "";
    }

    const secondaryContents = data?.contents?.twoColumnBrowseResultsRenderer?.secondaryContents?.sectionListRenderer?.contents || [];
    const tracks: any[] = [];

    for (const section of secondaryContents) {
      if (section.musicPlaylistShelfRenderer) {
        for (const item of (section.musicPlaylistShelfRenderer.contents || [])) {
          const parsed = parseMusicItem(item.musicResponsiveListItemRenderer);
          if (parsed) tracks.push(parsed);
        }
      }
      if (section.musicShelfRenderer) {
        for (const item of (section.musicShelfRenderer.contents || [])) {
          const parsed = parseMusicItem(item.musicResponsiveListItemRenderer);
          if (parsed) tracks.push(parsed);
        }
      }
    }

    if (tracks.length === 0) {
      const singleColumn = data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
      for (const section of singleColumn) {
        if (section.musicShelfRenderer) {
          for (const item of (section.musicShelfRenderer.contents || [])) {
            const parsed = parseMusicItem(item.musicResponsiveListItemRenderer);
            if (parsed) tracks.push(parsed);
          }
        }
      }
    }

    return { playlistId: playlistId.replace(/^VL/, ""), title, author, description, thumbnail, trackCount: tracks.length, tracks };
  }

  // ─── Browse: Charts & Moods ───────────────────────────────

  async getCharts(country?: string) {
    const data = await this.makeRequest("browse", { browseId: "FEmusic_charts", formData: { selectedValues: [country || "US"] } });
    return this.parseChartsData(data);
  }

  async getMoodCategories() {
    const data = await this.makeRequest("browse", { browseId: "FEmusic_moods_and_genres" });
    return this.parseMoodsData(data);
  }

  async getMoodPlaylists(categoryId: string) {
    const data = await this.makeRequest("browse", { browseId: categoryId });
    const contents = data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
    const playlists: any[] = [];
    for (const section of contents) {
      for (const item of (section.musicShelfRenderer?.contents || [])) {
        const parsed = parseMusicItem(item.musicResponsiveListItemRenderer);
        if (parsed) playlists.push(parsed);
      }
    }
    return playlists;
  }

  // ─── Watch Playlist & Related ─────────────────────────────

  async getWatchPlaylist(videoId?: string, playlistId?: string, radio = false, shuffle = false, limit = 25) {
    const data = await this.makeRequest("next", { videoId, playlistId, radio, shuffle });
    const contents = data?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer?.watchNextTabbedResultsRenderer
      ?.tabs?.[0]?.tabRenderer?.content?.musicQueueRenderer?.content?.playlistPanelRenderer?.contents || [];

    const tracks = contents.map((item: any) => {
      const video = item.playlistPanelVideoRenderer;
      if (!video) return null;
      return { videoId: video.videoId, title: video.title?.runs?.[0]?.text, author: video.shortBylineText?.runs?.[0]?.text, thumbnail: video.thumbnail?.thumbnails?.[0]?.url };
    }).filter(Boolean);

    return { tracks: tracks.slice(0, limit) };
  }

  async getRelated(videoId: string) {
    const url = `https://www.youtube.com/youtubei/v1/next?key=${this.apiKey}`;
    const body = { videoId, context: { client: { clientName: "WEB", clientVersion: "2.20251013.01.00" } } };

    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json();

    const secondaryResults = data?.contents?.twoColumnWatchNextResults?.secondaryResults?.secondaryResults?.results || [];
    const results: any[] = [];

    for (const item of secondaryResults) {
      if (item.lockupViewModel) {
        const lockup = item.lockupViewModel;
        const metadata = lockup.metadata?.lockupMetadataViewModel;
        const contentImage = lockup.contentImage?.collectionThumbnailViewModel?.primaryThumbnail?.thumbnailViewModel;
        const vid = lockup.rendererContext?.commandContext?.onTap?.innertubeCommand?.watchEndpoint?.videoId || lockup.contentId;
        if (vid) {
          results.push({
            videoId: vid,
            title: metadata?.title?.content,
            artist: metadata?.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts?.[0]?.text?.content,
            thumbnail: contentImage?.image?.sources?.[0]?.url,
            duration: metadata?.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts?.[2]?.text?.content,
          });
        }
      } else if (item.compactVideoRenderer) {
        const video = item.compactVideoRenderer;
        const durationText = video.lengthText?.simpleText || "";
        let durationSeconds = 0;
        if (durationText) {
          const parts = durationText.split(":").map((p: string) => parseInt(p) || 0);
          if (parts.length === 2) durationSeconds = parts[0] * 60 + parts[1];
          else if (parts.length === 3) durationSeconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
        }
        if (video.videoId && !(durationSeconds > 0 && durationSeconds <= 60)) {
          results.push({
            videoId: video.videoId,
            title: video.title?.simpleText || video.title?.runs?.[0]?.text,
            artist: video.shortBylineText?.runs?.[0]?.text,
            thumbnail: video.thumbnail?.thumbnails?.[0]?.url,
            duration: durationText,
          });
        }
      }
    }

    return results.slice(0, 20);
  }

  // ─── Private: HTTP ────────────────────────────────────────

  private async makeRequest(endpoint: string, params: any) {
    const url = `${this.baseURL}/${endpoint}?key=${this.apiKey}`;
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ context: this.context, ...params }) });
    return response.json();
  }

  private async makeRequestWithContext(endpoint: string, params: any, context: any) {
    const url = `${this.baseURL}/${endpoint}?key=${this.apiKey}`;
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ context, ...params }) });
    return response.json();
  }

  // ─── Private: Filters ─────────────────────────────────────

  private getFilterParams(filter?: string): string | undefined {
    if (!filter) return undefined;
    const filterMap: Record<string, string> = {
      songs: "EgWKAQIIAWoKEAkQAxAEEAoQBQ%3D%3D",
      videos: "EgWKAQIQAWoKEAkQAxAEEAoQBQ%3D%3D",
      albums: "EgWKAQIYAWoKEAkQAxAEEAoQBQ%3D%3D",
      artists: "EgWKAQIgAWoKEAkQAxAEEAoQBQ%3D%3D",
      playlists: "EgWKAQIoAWoKEAkQAxAEEAoQBQ%3D%3D",
      community_playlists: "EgeKAQQoAEABagoQAxAEEAkQChAF",
      featured_playlists: "EgeKAQQoADgBagoQAxAEEAkQChAF",
    };
    return filterMap[filter] || undefined;
  }

  // ─── Private: Charts/Moods parsing ────────────────────────

  private parseChartsData(data: any) {
    const results: any[] = [];
    const contents = data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
    for (const section of contents) {
      if (section.musicCarouselShelfRenderer) {
        const title = section.musicCarouselShelfRenderer?.header?.musicCarouselShelfBasicHeaderRenderer?.title?.runs?.[0]?.text;
        const items = (section.musicCarouselShelfRenderer?.contents || []).map((item: any) => parseTwoRowItem(item.musicTwoRowItemRenderer || item.musicResponsiveListItemRenderer)).filter(Boolean);
        if (title && items.length) results.push({ title, items });
      }
      if (section.musicShelfRenderer) {
        const title = section.musicShelfRenderer?.title?.runs?.[0]?.text;
        const items = (section.musicShelfRenderer?.contents || []).map((item: any) => parseMusicItem(item.musicResponsiveListItemRenderer)).filter(Boolean);
        if (title && items.length) results.push({ title, items });
      }
    }
    return results;
  }

  private parseMoodsData(data: any) {
    const results: any[] = [];
    const contents = data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
    for (const section of contents) {
      if (section.gridRenderer) {
        const items = (section.gridRenderer?.items || []).map((item: any) => {
          const nav = item.musicNavigationButtonRenderer;
          if (!nav) return null;
          return { title: nav.buttonText?.runs?.[0]?.text, browseId: nav.clickCommand?.browseEndpoint?.browseId, color: nav.solid?.leftStripeColor };
        }).filter(Boolean);
        if (items.length) results.push({ title: "Moods & Genres", items });
      }
      if (section.musicCarouselShelfRenderer) {
        const title = section.musicCarouselShelfRenderer?.header?.musicCarouselShelfBasicHeaderRenderer?.title?.runs?.[0]?.text;
        const items = (section.musicCarouselShelfRenderer?.contents || []).map((item: any) => {
          const nav = item.musicNavigationButtonRenderer;
          if (!nav) return null;
          return { title: nav.buttonText?.runs?.[0]?.text, browseId: nav.clickCommand?.browseEndpoint?.browseId, color: nav.solid?.leftStripeColor };
        }).filter(Boolean);
        if (title && items.length) results.push({ title, items });
      }
    }
    return results;
  }
}
