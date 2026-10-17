// FRED (Federal Reserve Economic Data) publishes a public CSV endpoint with
// no API key required — used here for Treasury yields and VIX close.

import { get } from "node:https";

export type SeriesPoint = { date: string; value: number };

// Some Node versions (seen on 26) negotiate HTTP/2 with FRED and fail every
// request with ERR_HTTP2_STREAM_ERROR, so fall back to a plain HTTP/1.1 GET.
function getHttp1(url: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = get(url, { timeout: 30_000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

async function fetchCsv(url: string): Promise<{ status: number; text: string }> {
  try {
    const res = await fetch(url);
    return { status: res.status, text: res.ok ? await res.text() : "" };
  } catch {
    return getHttp1(url);
  }
}

export async function series(seriesId: string, lastN = 260): Promise<SeriesPoint[]> {
  const { status, text } = await fetchCsv(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${seriesId}`);
  if (status < 200 || status >= 300) throw new Error(`fred ${status} for ${seriesId}`);
  const lines = text.trim().split("\n").slice(1); // drop header row
  const points: SeriesPoint[] = [];
  for (const line of lines) {
    const [date, raw] = line.split(",");
    const value = Number(raw);
    if (!date || !isFinite(value)) continue;
    points.push({ date, value });
  }
  return points.slice(-lastN);
}

export async function latest(seriesId: string): Promise<SeriesPoint | null> {
  const points = await series(seriesId, 5);
  return points.length > 0 ? points[points.length - 1] : null;
}
