/**
 * Feed Routes
 * /api/feed/unauthenticated, /api/feed/channels=...
 */

import { json, error } from "../helpers/response.ts";

export async function handleFeedRoutes(pathname: string, searchParams: URLSearchParams): Promise<Response | null> {
  if (pathname === "/api/feed/unauthenticated" || pathname.startsWith("/api/feed/channels=")) {
    let channelsParam = searchParams.get("channels");
    if (pathname.startsWith("/api/feed/channels=")) {
      channelsParam = pathname.replace("/api/feed/channels=", "").split("?")[0];
    }
    if (!channelsParam) return error("No channel IDs provided");

    const channelIds = channelsParam.split(",").map(s => s.trim()).filter(Boolean);
    const preview = searchParams.get("preview") === "1";
    const results: any[] = [];

    for (const channelId of channelIds) {
      results.push(...await fetchChannelVideos(channelId, preview ? 5 : undefined));
    }

    return json(results.filter(item => !item.isShort).sort((a, b) => Number(b.uploaded) - Number(a.uploaded)));
  }

  return null;
}

// ─── Channel Video Fetching ─────────────────────────────────

async function fetchChannelVideos(channelId: string, limit?: number): Promise<any[]> {
  try {
    const response = await fetch("https://www.youtube.com/youtubei/v1/browse?prettyPrint=false", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        browseId: channelId,
        context: { client: { clientName: "WEB", clientVersion: "2.20251013.01.00", hl: "en", gl: "US" } },
      }),
    });
    const data = await response.json();
    const items: any[] = [];
    const channelName = data?.header?.c4TabbedHeaderRenderer?.title || data?.metadata?.channelMetadataRenderer?.title || "";

    const extractVideos = (contents: any[]) => {
      if (!contents) return;
      for (const item of contents) {
        const video = item?.richItemRenderer?.content?.videoRenderer || item?.videoRenderer || item?.gridVideoRenderer;
        if (video?.videoId) items.push(parseVideo(video, channelId, channelName));
        if (item?.shelfRenderer?.content?.expandedShelfContentsRenderer?.items) extractVideos(item.shelfRenderer.content.expandedShelfContentsRenderer.items);
        if (item?.itemSectionRenderer?.contents) extractVideos(item.itemSectionRenderer.contents);
        if (limit && items.length >= limit) return;
      }
    };

    const tabs = data?.contents?.twoColumnBrowseResultsRenderer?.tabs || data?.contents?.singleColumnBrowseResultsRenderer?.tabs || [];
    for (const tab of tabs) {
      extractVideos(tab?.tabRenderer?.content?.sectionListRenderer?.contents || tab?.tabRenderer?.content?.richGridRenderer?.contents || []);
    }
    return items.slice(0, limit || items.length);
  } catch {
    return [];
  }
}

function parseVideo(video: any, channelId: string, channelName: string): any {
  const id = video?.videoId || "";
  const title = video?.title?.runs?.[0]?.text || video?.title?.simpleText || "";

  let duration = 0;
  const durationText = video?.lengthText?.simpleText || video?.thumbnailOverlays?.[0]?.thumbnailOverlayTimeStatusRenderer?.text?.simpleText || "";
  if (durationText) {
    const parts = durationText.split(":").map((p: string) => parseInt(p) || 0);
    if (parts.length === 2) duration = parts[0] * 60 + parts[1];
    else if (parts.length === 3) duration = parts[0] * 3600 + parts[1] * 60 + parts[2];
  }

  let views = 0;
  const viewText = video?.viewCountText?.simpleText || "";
  const match = viewText.match(/([\d,\.]+)([KMB]?)/);
  if (match) {
    let num = parseFloat(match[1].replace(/,/g, ""));
    if (match[2] === "K") num *= 1000;
    else if (match[2] === "M") num *= 1000000;
    else if (match[2] === "B") num *= 1000000000;
    views = Math.floor(num);
  }

  let uploaded = Date.now();
  const timeText = (video?.publishedTimeText?.simpleText || "").toLowerCase();
  if (timeText.includes("hour")) uploaded -= parseInt(timeText.match(/(\d+)/)?.[1] || "1") * 3600000;
  else if (timeText.includes("day")) uploaded -= parseInt(timeText.match(/(\d+)/)?.[1] || "1") * 86400000;
  else if (timeText.includes("week")) uploaded -= parseInt(timeText.match(/(\d+)/)?.[1] || "1") * 604800000;
  else if (timeText.includes("month")) uploaded -= parseInt(timeText.match(/(\d+)/)?.[1] || "1") * 2592000000;
  else if (timeText.includes("year")) uploaded -= parseInt(timeText.match(/(\d+)/)?.[1] || "1") * 31536000000;

  return {
    id, authorId: channelId, duration: duration.toString(), author: channelName,
    views: views.toString(), uploaded: uploaded.toString(), title,
    isShort: duration > 0 && duration <= 60,
    thumbnail: video?.thumbnail?.thumbnails?.slice(-1)[0]?.url || "",
  };
}
