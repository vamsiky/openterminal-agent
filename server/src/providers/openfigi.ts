// OpenFIGI (https://www.openfigi.com/api): Bloomberg's free identifier
// mapping. Used to find the US listing of a foreign ticker (routes/us-listing.ts).
//
// Works without a key at 25 requests a minute and 10 jobs a request;
// OPENFIGI_API_KEY raises that to 25 requests every 6 seconds and 100 jobs.
// A 429 or any other HTTP error throws, so callers can retry later rather than
// cache "no listing".

const ENDPOINT = "https://api.openfigi.com/v3/mapping";
const TIMEOUT_MS = 10_000;

export type MappingJob = { idType: string; idValue: string; exchCode?: string };

/** The fields of a mapping result that the US-listing lookup reads. */
export type FigiRecord = {
  ticker: string | null;
  exchCode: string | null;
  name: string | null;
  securityType: string | null;
  securityType2: string | null;
  marketSector: string | null;
  shareClassFIGI: string | null;
};

export class OpenFigiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "OpenFigiError";
  }
}

const apiKey = () => process.env.OPENFIGI_API_KEY?.trim() || null;

const record = (d: any): FigiRecord => ({
  ticker: d.ticker ?? null,
  exchCode: d.exchCode ?? null,
  name: d.name ?? null,
  securityType: d.securityType ?? null,
  securityType2: d.securityType2 ?? null,
  marketSector: d.marketSector ?? null,
  shareClassFIGI: d.shareClassFIGI ?? null,
});

/**
 * Map each job to its records, in order: [] when OpenFIGI knows no such
 * identifier, null when that one job failed. Jobs go in chunks of the plan's
 * per-request limit, one request after another.
 */
export async function map(jobs: MappingJob[]): Promise<Array<FigiRecord[] | null>> {
  const key = apiKey();
  const size = key ? 100 : 10;
  const out: Array<FigiRecord[] | null> = [];
  for (let i = 0; i < jobs.length; i += size) {
    const chunk = jobs.slice(i, i + size);
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(key ? { "X-OPENFIGI-APIKEY": key } : {}) },
      body: JSON.stringify(chunk),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new OpenFigiError(res.status, `openfigi: ${res.status}`);
    const body = (await res.json()) as Array<{ data?: unknown[]; warning?: string; error?: string }>;
    if (!Array.isArray(body) || body.length !== chunk.length) throw new OpenFigiError(res.status, "openfigi: unexpected response");
    // "No identifier found." comes back as a warning; anything else as an error.
    for (const r of body) out.push(Array.isArray(r.data) ? r.data.map(record) : r.warning ? [] : null);
  }
  return out;
}
