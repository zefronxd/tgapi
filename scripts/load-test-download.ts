const baseUrl = (Deno.args[0] || "http://127.0.0.1:5000").replace(/\/$/, "");
const ids = (Deno.args[1] || "WOdnRhWeHoY")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);
const count = Math.max(1, Number(Deno.args[2] || 20));

const startedAt = performance.now();
const results = await Promise.all(
  Array.from({ length: count }, async (_, index) => {
    const id = ids[index % ids.length];
    const requestStartedAt = performance.now();
    try {
      const response = await fetch(
        `${baseUrl}/api/download?id=${encodeURIComponent(id)}&format=mp3&filename=load-${index}`,
      );
      const bytes = await response.arrayBuffer();
      return {
        index,
        id,
        status: response.status,
        bytes: bytes.byteLength,
        ms: Math.round(performance.now() - requestStartedAt),
      };
    } catch (error) {
      return {
        index,
        id,
        status: 0,
        bytes: 0,
        ms: Math.round(performance.now() - requestStartedAt),
        error: String(error).slice(0, 160),
      };
    }
  }),
);

const successful = results.filter((result) => result.status >= 200 && result.status < 300);
const failed = results.filter((result) => !successful.includes(result));
const durations = results.map((result) => result.ms).sort((a, b) => a - b);
const percentile = (fraction: number) =>
  durations[Math.min(durations.length - 1, Math.floor(durations.length * fraction))] || 0;

console.log(JSON.stringify({
  baseUrl,
  requested: count,
  successful: successful.length,
  failed: failed.length,
  totalMs: Math.round(performance.now() - startedAt),
  p50Ms: percentile(0.5),
  p95Ms: percentile(0.95),
  maxMs: durations.at(-1) || 0,
  failures: failed.slice(0, 10),
}, null, 2));