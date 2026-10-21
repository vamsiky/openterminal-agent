// FRED (Federal Reserve Economic Data) publishes a public CSV endpoint with
// no API key required — used here for Treasury yields and VIX close.

export type SeriesPoint = { date: string; value: number };

// FRED resets HTTP/2 streams for some default client User-Agents (seen with
// Node 26's fetch: ERR_HTTP2_STREAM_ERROR) and stalls browser-like ones, so
// identify as a plain non-browser client.
const HEADERS = { "User-Agent": "openterminal/0.1" };

export async function series(seriesId: string, lastN = 260): Promise<SeriesPoint[]> {
  const res = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${seriesId}`, { headers: HEADERS, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`fred ${res.status} for ${seriesId}`);
  const text = await res.text();
  const lines = text.trim().split("\n");
  // A maintenance or error page comes back as HTML with status 200; its lines must never be read as observations.
  const header = (lines.shift() ?? "").trim().split(",")[0].toLowerCase();
  if (header !== "date" && header !== "observation_date") throw new Error(`fred returned a non-CSV response for ${seriesId}`);
  const points: SeriesPoint[] = [];
  for (const line of lines) {
    const [date, raw = ""] = line.trim().split(",");
    // Missing observations are "." in older files and empty in newer ones;
    // Number("") is 0, so check for an actual value first.
    const value = raw.trim() === "" ? NaN : Number(raw);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isFinite(value)) continue;
    points.push({ date, value });
  }
  return points.slice(-lastN);
}

export async function latest(seriesId: string): Promise<SeriesPoint | null> {
  const points = await series(seriesId, 5);
  return points.length > 0 ? points[points.length - 1] : null;
}
