/**
 * YouTube Music response parsers
 * Extracts structured data from YouTube Music's internal API responses
 */

export function parseSearchResults(data: any) {
  const results: any[] = [];
  let continuationToken: string | null = null;

  // Handle continuation responses
  const actions = data?.onResponseReceivedCommands || [];
  for (const action of actions) {
    const items = action?.appendContinuationItemsAction?.continuationItems || [];
    for (const entry of items) {
      if (entry.musicShelfRenderer || entry.musicShelfContinuation) {
        const shelf = entry.musicShelfRenderer || entry.musicShelfContinuation;
        for (const item of (shelf.contents || [])) {
          const parsed = parseMusicItem(item.musicResponsiveListItemRenderer);
          if (parsed) results.push(parsed);
        }
        continuationToken = shelf.continuations?.[0]?.nextContinuationData?.continuation || continuationToken;
      }
      if (entry.continuationItemRenderer) {
        continuationToken = entry.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token || continuationToken;
      }
    }
  }

  // Handle initial results
  if (results.length === 0) {
    const sections = data?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
    for (const section of sections) {
      if (section.musicCardShelfRenderer) {
        const topResult = parseTopResultCard(section.musicCardShelfRenderer);
        if (topResult) results.push(topResult);
      }
      if (section.musicShelfRenderer) {
        for (const item of (section.musicShelfRenderer.contents || [])) {
          const parsed = parseMusicItem(item.musicResponsiveListItemRenderer);
          if (parsed) results.push(parsed);
        }
        continuationToken = section.musicShelfRenderer.continuations?.[0]?.nextContinuationData?.continuation || continuationToken;
      }
    }
  }

  return { results, continuationToken };
}

export function parseTopResultCard(card: any) {
  if (!card) return null;

  const title = card.title?.runs?.[0]?.text;
  const subtitleRuns = card.subtitle?.runs || [];
  const thumbnail = card.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails?.[0]?.url;
  const videoId = card.onTap?.watchEndpoint?.videoId || card.buttons?.[0]?.buttonRenderer?.command?.watchEndpoint?.videoId;
  const browseId = card.onTap?.browseEndpoint?.browseId;

  const subtitleText = subtitleRuns.map((r: any) => r.text).join("");
  let resultType = "song";
  const lower = subtitleText.toLowerCase();
  if (lower.includes("video") || lower.includes("vidéo")) resultType = "video";
  else if (lower.includes("artist") || lower.includes("artiste")) resultType = "artist";
  else if (lower.includes("album")) resultType = "album";
  else if (lower.includes("playlist")) resultType = "playlist";

  const artistRun = subtitleRuns.find((r: any) =>
    r.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType === "MUSIC_PAGE_TYPE_ARTIST"
  );
  const artists = artistRun ? [{ name: artistRun.text, id: artistRun.navigationEndpoint?.browseEndpoint?.browseId }] : [];

  return { title, thumbnails: [{ url: thumbnail }], videoId, browseId, artists, resultType, isTopResult: true, subtitle: subtitleText };
}

export function parseSuggestions(data: any): string[] {
  const suggestions: string[] = [];
  const contents = data?.contents?.[0]?.searchSuggestionsSectionRenderer?.contents || data?.contents || [];
  for (const content of contents) {
    const runs = content?.searchSuggestionRenderer?.suggestion?.runs || [];
    const text = runs.map((r: any) => r.text).join("");
    if (text) suggestions.push(text);
  }
  return suggestions;
}

export function parseMusicItem(item: any) {
  if (!item) return null;

  const title = item.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.text;
  const thumbnail = item.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails?.[0]?.url;
  const videoId = item.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer
    ?.playNavigationEndpoint?.watchEndpoint?.videoId;
  const browseId = item.navigationEndpoint?.browseEndpoint?.browseId;

  const subtitle = item.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
  const artists = subtitle
    .filter((r: any) => r.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs
      ?.browseEndpointContextMusicConfig?.pageType === "MUSIC_PAGE_TYPE_ARTIST")
    .map((r: any) => ({ name: r.text, id: r.navigationEndpoint?.browseEndpoint?.browseId }));

  const duration = item.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text?.runs?.[0]?.text;

  return {
    title,
    thumbnails: [{ url: thumbnail }],
    videoId,
    browseId,
    artists,
    duration,
    resultType: videoId ? "song" : browseId?.startsWith("UC") ? "artist" : "album",
  };
}

export function parseTwoRowItem(item: any) {
  if (!item) return null;
  return {
    title: item.title?.runs?.[0]?.text,
    subtitle: item.subtitle?.runs?.map((r: any) => r.text).join(""),
    thumbnails: item.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails,
    videoId: item.navigationEndpoint?.watchEndpoint?.videoId,
    browseId: item.navigationEndpoint?.browseEndpoint?.browseId,
    playlistId: item.navigationEndpoint?.watchEndpoint?.playlistId,
  };
}
