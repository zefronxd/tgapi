/**
 * Server-only YouTube cookie loading.
 *
 * Cookie files are used for authenticated media resolution and are never
 * returned in API responses or exposed as static assets.
 */

function isNetscapeCookieFile(text: string): boolean {
  return text.split(/\r?\n/, 1)[0].includes("Netscape HTTP Cookie File");
}

export async function findCookieFile(): Promise<string | null> {
  const configured = Deno.env.get("YTDLP_COOKIE_FILE");
  if (configured) {
    try {
      const stat = await Deno.stat(configured);
      return stat.isFile ? configured : null;
    } catch {
      return null;
    }
  }

  // A local root-level cookies.txt is the explicit project cookie source.
  try {
    const stat = await Deno.stat("cookies.txt");
    if (stat.isFile && isNetscapeCookieFile(await Deno.readTextFile("cookies.txt"))) {
      return "cookies.txt";
    }
  } catch {
    // Fall back to uploaded cookie files below.
  }

  const candidates: Array<{ path: string; modified: number }> = [];
  try {
    for await (const entry of Deno.readDir("attached_assets")) {
      if (!entry.isFile || !entry.name.endsWith(".txt")) continue;
      const path = `attached_assets/${entry.name}`;
      try {
        const text = await Deno.readTextFile(path);
        if (!isNetscapeCookieFile(text)) continue;
        const stat = await Deno.stat(path);
        candidates.push({ path, modified: stat.mtime?.getTime() || 0 });
      } catch {
        // Ignore files that disappear or cannot be read.
      }
    }
  } catch {
    // Cookie files are optional for public videos.
  }

  candidates.sort((a, b) => b.modified - a.modified);
  return candidates[0]?.path || null;
}

export async function cookieHeader(): Promise<string | null> {
  const path = await findCookieFile();
  if (!path) return null;

  try {
    const text = await Deno.readTextFile(path);
    const cookies = text
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const parts = line.split("\t");
        return parts.length >= 7 ? `${parts[5]}=${parts.slice(6).join("=")}` : "";
      })
      .filter(Boolean);
    return cookies.length ? cookies.join("; ") : null;
  } catch {
    return null;
  }
}