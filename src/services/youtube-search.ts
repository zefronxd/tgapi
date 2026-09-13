/**
 * YouTube Search Service
 * Searches YouTube for videos, channels, and playlists via web scraping
 */

export class YouTubeSearch {
  private searchURL = "https://www.youtube.com/results";
  private continuationURL = "https://www.youtube.com/youtubei/v1/search";
  private suggestionsURL = "https://suggestqueries-clients6.youtube.com/complete/search";
  private apiKey: string | null = null;
  private clientVersion: string | null = null;

  async searchVideos(query: string | null, continuationToken?: string) {
    if (continuationToken) return this.fetchContinuation(continuationToken, "video");
    if (!query) throw new Error("Query is required for initial search");

    const response = await fetch(`${this.searchURL}?search_query=${encodeURIComponent(query.normalize("NFC"))}&sp=EgIQAQ%253D%253D`);
    const html = await response.text();
    this.extractAPIConfig(html);
    return this.parseVideoResults(html);
  }

  async searchChannels(query: string | null, continuationToken?: string) {
    if (continuationToken) return this.fetchContinuation(continuationToken, "channel");
    if (!query) throw new Error("Query is required for initial search");

    const response = await fetch(`${this.searchURL}?search_query=${encodeURIComponent(query.normalize("NFC"))}&sp=EgIQAg%253D%253D`);
    const html = await response.text();
    this.extractAPIConfig(html);
    return this.parseChannelResults(html);
  }

  async searchPlaylists(query: string | null, continuationToken?: string) {
    if (continuationToken) return this.fetchContinuation(continuationToken, "playlist");
    if (!query) throw new Error("Query is required for initial search");

    const response = await fetch(`${this.searchURL}?search_query=${encodeURIComponent(query.normalize("NFC"))}&sp=EgIQAw%253D%253D`);
    const html = await response.text();
    this.extractAPIConfig(html);
    return this.parsePlaylistResults(html);
  }

  async getSuggestions(query: string): Promise<string[]> {
    try {
      const url = `${this.suggestionsURL}?ds=yt&client=youtube&q=${encodeURIComponent(query.normalize("NFC"))}`;
      const response = await fetch(url);
      const text = await response.text();
      const start = text.indexOf("(");
      const end = text.lastIndexOf(")");
      if (start === -1 || end === -1) return this.getStaticSuggestions(query);
      const json = JSON.parse(text.slice(start + 1, end));
      return (json[1] || []).map((item: any) => Array.isArray(item) ? item[0] : item).slice(0, 10);
    } catch {
      return this.getStaticSuggestions(query);
    }
  }

  // ─── Private ──────────────────────────────────────────────

  private extractAPIConfig(html: string) {
    const apiKeyMatch = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
    const clientVersionMatch = html.match(/"clientVersion":"([^"]+)"/);
    if (apiKeyMatch) this.apiKey = apiKeyMatch[1];
    if (clientVersionMatch) this.clientVersion = clientVersionMatch[1];
  }

  private async fetchContinuation(token: string, type: string) {
    if (!this.apiKey) throw new Error("API key not initialized");
    const response = await fetch(`${this.continuationURL}?key=${this.apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ continuation: token, context: { client: { clientName: "WEB", clientVersion: this.clientVersion || "2.20231219.01.00" } } }),
    });
    const data = await response.json();
    return this.parseContinuationResults(data, type);
  }

  private parseVideoResults(html: string) {
    const results: any[] = [];
    let continuationToken: string | null = null;
    const jsonMatch = html.match(/var ytInitialData = ({.+?});/);
    if (!jsonMatch) return { results, continuationToken };

    const data = JSON.parse(jsonMatch[1]);
    const sections = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
    const items = sections[0]?.itemSectionRenderer?.contents || [];
    for (const item of items) {
      if (item.videoRenderer) results.push(this.parseVideoRenderer(item.videoRenderer));
    }
    continuationToken = this.extractContinuationToken(data);
    return { results, continuationToken };
  }

  private parseChannelResults(html: string) {
    const results: any[] = [];
    let continuationToken: string | null = null;
    const jsonMatch = html.match(/var ytInitialData = ({.+?});/);
    if (!jsonMatch) return { results, continuationToken };

    const data = JSON.parse(jsonMatch[1]);
    const sections = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
    for (const section of sections) {
      for (const item of (section?.itemSectionRenderer?.contents || [])) {
        if (item.channelRenderer) results.push(this.parseChannelRenderer(item.channelRenderer));
      }
    }
    continuationToken = this.extractContinuationToken(data);
    return { results, continuationToken };
  }

  private parsePlaylistResults(html: string) {
    const results: any[] = [];
    let continuationToken: string | null = null;
    const jsonMatch = html.match(/var ytInitialData = ({.+?});/);
    if (!jsonMatch) return { results, continuationToken };

    const data = JSON.parse(jsonMatch[1]);
    const sections = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
    for (const section of sections) {
      for (const item of (section?.itemSectionRenderer?.contents || [])) {
        if (item.playlistRenderer) results.push(this.parsePlaylistRenderer(item.playlistRenderer));
      }
    }
    continuationToken = this.extractContinuationToken(data);
    return { results, continuationToken };
  }

  private parseContinuationResults(data: any, type: string) {
    const results: any[] = [];
    let continuationToken: string | null = null;
    const actions = data?.onResponseReceivedCommands || [];
    for (const action of actions) {
      const items = action?.appendContinuationItemsAction?.continuationItems || [];
      for (const item of items) {
        if (item.continuationItemRenderer) {
          continuationToken = item.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
          continue;
        }
        if (type === "video" && item.videoRenderer) results.push(this.parseVideoRenderer(item.videoRenderer));
        else if (type === "channel" && item.channelRenderer) results.push(this.parseChannelRenderer(item.channelRenderer));
        else if (type === "playlist" && item.playlistRenderer) results.push(this.parsePlaylistRenderer(item.playlistRenderer));
        if (item.itemSectionRenderer?.contents) {
          for (const inner of item.itemSectionRenderer.contents) {
            if (type === "video" && inner.videoRenderer) results.push(this.parseVideoRenderer(inner.videoRenderer));
            else if (type === "channel" && inner.channelRenderer) results.push(this.parseChannelRenderer(inner.channelRenderer));
            else if (type === "playlist" && inner.playlistRenderer) results.push(this.parsePlaylistRenderer(inner.playlistRenderer));
          }
        }
      }
    }
    return { results, continuationToken };
  }

  private extractContinuationToken(data: any): string | null {
    const sections = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
    for (const section of sections) {
      if (section.continuationItemRenderer) {
        return section.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token || null;
      }
    }
    return null;
  }

  private parseVideoRenderer(v: any) {
    return {
      type: "video",
      id: v.videoId,
      title: v.title?.runs?.[0]?.text,
      duration: v.lengthText?.simpleText,
      channel: { id: v.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId, name: v.ownerText?.runs?.[0]?.text },
      thumbnails: v.thumbnail?.thumbnails,
      publishedTime: v.publishedTimeText?.simpleText,
      viewCount: { text: v.viewCountText?.simpleText },
      link: `https://www.youtube.com/watch?v=${v.videoId}`,
    };
  }

  private parseChannelRenderer(c: any) {
    return {
      type: "channel",
      channelId: c.channelId,
      title: c.title?.simpleText,
      thumbnail: c.thumbnail?.thumbnails?.[0]?.url,
      subscriberCount: c.subscriberCountText?.simpleText,
      videoCount: c.videoCountText?.simpleText,
      url: `https://www.youtube.com/channel/${c.channelId}`,
    };
  }

  private parsePlaylistRenderer(p: any) {
    return {
      type: "playlist",
      playlistId: p.playlistId,
      title: p.title?.simpleText,
      thumbnail: p.thumbnails?.[0]?.thumbnails?.[0]?.url,
      videoCount: p.videoCount,
      author: p.shortBylineText?.runs?.[0]?.text,
      url: `https://www.youtube.com/playlist?list=${p.playlistId}`,
    };
  }

  private getStaticSuggestions(query: string): string[] {
    return [query, `${query} video`, `${query} 2024`, `${query} tutorial`, `${query} song`];
  }
}
