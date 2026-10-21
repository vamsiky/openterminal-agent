import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetState } from "./fmp-core.js";
import { fetchTranscript, fetchTranscriptDates, latestFilingsByForm, pressReleases, symbolFilings } from "./fmp-content.js";

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => "", headers: new Headers() });
const bad = (status: number) => ({ ok: false, status, json: async () => ({}), text: async () => "nope", headers: new Headers() });

function stub(handler: (url: URL) => unknown) {
  const f = vi.fn(async (u: string) => handler(new URL(u)));
  vi.stubGlobal("fetch", f);
  return f;
}

describe("fmp-content", () => {
  beforeEach(() => {
    process.env.FMP_API_KEY = "test-key";
    resetState();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("lists transcript dates newest first and converts the share class", async () => {
    const f = stub(() => ok([{ quarter: 1, fiscalYear: 2025, date: "2025-02-01" }, { quarter: 2, fiscalYear: 2025, date: "2025-05-01" }, { quarter: null, fiscalYear: 2025, date: "x" }]));
    const dates = await fetchTranscriptDates("BRK.B");
    expect(dates.map((d) => d.date)).toEqual(["2025-05-01", "2025-02-01"]);
    expect(new URL(f.mock.calls[0][0]).searchParams.get("symbol")).toBe("BRK-B");
  });

  it("returns null for an empty transcript and a transcript with its fiscal period", async () => {
    stub(() => ok([]));
    expect(await fetchTranscript("AAPL", 2026, 4)).toBeNull();
    stub(() => ok([{ symbol: "AAPL", period: "Q4", year: 2025, date: "2025-10-30", content: "Hello" }]));
    expect(await fetchTranscript("AAPL", 2025, 4)).toEqual({ symbol: "AAPL", fiscalYear: 2025, quarter: 4, date: "2025-10-30", content: "Hello" });
  });

  it("treats a plan without the dataset (403) as empty but rethrows other failures", async () => {
    stub(() => bad(403));
    expect(await fetchTranscriptDates("AAPL")).toEqual([]);
    stub(() => bad(500));
    await expect(fetchTranscriptDates("AAPL")).rejects.toThrow(/500/);
  });

  it("keeps full press-release text and drops the image", async () => {
    stub(() => ok([{ symbol: "AAPL", publishedDate: "2026-10-13 08:56:00", publisher: "Business Wire", title: "T", image: "i", site: "s", text: "full text", url: "u" }, { title: "no date" }]));
    expect(await pressReleases("AAPL", 5)).toEqual([{ symbol: "AAPL", publishedDate: "2026-10-13 08:56:00", publisher: "Business Wire", title: "T", site: "s", text: "full text", url: "u" }]);
  });

  it("filters per-symbol filings by form (8-K includes 8-K/A) and sorts newest first", async () => {
    const row = (formType: string, acceptedDate: string) => ({ symbol: "AAPL", cik: "1", filingDate: acceptedDate.slice(0, 10) + " 00:00:00", acceptedDate, formType, link: "l", finalLink: "f" });
    const f = stub(() => ok([row("4", "2026-10-19 10:00:00"), row("8-K", "2026-09-01 10:00:00"), row("8-K/A", "2026-10-01 10:00:00"), row("10-Q", "2026-08-01 10:00:00")]));
    const out = await symbolFilings("AAPL", { from: "2025-01-01", to: "2026-10-21", limit: 5, type: "8-k" });
    expect(out.map((x) => x.formType)).toEqual(["8-K/A", "8-K"]);
    expect(new URL(f.mock.calls[0][0]).searchParams.get("from")).toBe("2025-01-01");
  });

  it("asks the market-wide form-type feed with a date range", async () => {
    const f = stub(() => ok([]));
    await latestFilingsByForm("8-K", { from: "2026-10-14", to: "2026-10-21", limit: 3 });
    const u = new URL(f.mock.calls[0][0]);
    expect(u.pathname).toMatch(/sec-filings-search\/form-type$/);
    expect(u.searchParams.get("formType")).toBe("8-K");
    expect(u.searchParams.get("limit")).toBe("3");
  });
});
