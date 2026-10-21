import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => "", headers: new Headers() });

let tmpDir: string;
let job: typeof import("./transcripts-job.js");
let store: typeof import("./transcripts-store.js");
let core: typeof import("../providers/fmp-core.js");
let db: typeof import("../db.js").db;
let calls: URL[];
// symbol -> available transcripts, as FMP would list them
let available: Record<string, Array<{ fiscalYear: number; quarter: number; date: string }>>;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-tjob-test-"));
  process.env.DATA_DIR = tmpDir;
  process.env.FMP_API_KEY = "test-key";
  process.env.FMP_MAX_REQ_PER_MIN = "3000";
  core = await import("../providers/fmp-core.js");
  store = await import("./transcripts-store.js");
  job = await import("./transcripts-job.js");
  db = (await import("../db.js")).db;
});

afterAll(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

beforeEach(() => {
  core.resetState();
  db.exec("DELETE FROM content_transcripts; DELETE FROM content_transcripts_fts; DELETE FROM content_backfill; DELETE FROM content_job_runs; DELETE FROM earnings_calendar; DELETE FROM watchlist_items; DELETE FROM watchlists;");
  db.prepare("INSERT INTO watchlists (name) VALUES ('w')").run();
  calls = [];
  available = {};
  vi.stubGlobal("fetch", async (url: string) => {
    const u = new URL(url);
    calls.push(u);
    const symbol = u.searchParams.get("symbol")!;
    if (u.pathname.endsWith("earning-call-transcript-dates")) return ok(available[symbol] ?? []);
    const t = (available[symbol] ?? []).find((x) => String(x.fiscalYear) === u.searchParams.get("year") && String(x.quarter) === u.searchParams.get("quarter"));
    return ok(t ? [{ symbol, year: t.fiscalYear, period: `Q${t.quarter}`, date: t.date, content: `call ${symbol} ${t.date}` }] : []);
  });
});

const watch = (...symbols: string[]) => symbols.forEach((s, i) => db.prepare("INSERT INTO watchlist_items (watchlist_id, symbol, position) VALUES ((SELECT id FROM watchlists WHERE name = 'w'), ?, ?)").run(s, i));
const reported = (symbol: string, reportDate: string) =>
  db.prepare("INSERT INTO earnings_calendar (symbol, report_date, last_seen_day) VALUES (?, ?, '2026-10-21')").run(symbol, reportDate);
const quarters = (n: number) => Array.from({ length: n }, (_, i) => ({ fiscalYear: 2026 - Math.floor(i / 4), quarter: 4 - (i % 4), date: `2026-${String(10 - i).padStart(2, "0")}-15` }));

describe("runTranscriptJob", () => {
  it("backfills the last 4 transcripts once per watchlist symbol", async () => {
    watch("AAA", "BBB");
    available = { AAA: quarters(6), BBB: quarters(2) };
    const r = await job.runTranscriptJob("2026-10-21");
    expect(r).toMatchObject({ recent: 0, backfilled: 2, fetched: 6 });
    expect(store.storedDates("AAA")).toHaveLength(4);
    expect(store.storedDates("BBB")).toHaveLength(2);
    calls = [];
    expect(await job.runTranscriptJob("2026-10-22")).toMatchObject({ backfilled: 0, fetched: 0, calls: 0 });
    expect(calls).toHaveLength(0);
  });

  it("fetches the new transcript of a recent reporter, and retries the next day while FMP lacks it", async () => {
    watch("AAA");
    db.prepare("INSERT INTO content_backfill VALUES ('AAA', '2026-10-01')").run();
    reported("AAA", "2026-10-20");
    available = { AAA: [{ fiscalYear: 2026, quarter: 3, date: "2026-07-20" }] };
    expect(await job.runTranscriptJob("2026-10-21")).toMatchObject({ recent: 1, fetched: 0, calls: 1 });
    available = { AAA: [{ fiscalYear: 2026, quarter: 4, date: "2026-10-20" }, { fiscalYear: 2026, quarter: 3, date: "2026-07-20" }] };
    expect(await job.runTranscriptJob("2026-10-22")).toMatchObject({ recent: 1, fetched: 1, calls: 2 });
    expect(store.getStored("AAA", 2026, 4)?.content).toBe("call AAA 2026-10-20");
    expect(store.getStored("AAA", 2026, 3)).toBeNull();
  });

  it("ignores reporters outside the 10-day window and symbols not on a watchlist", async () => {
    watch("AAA");
    db.prepare("INSERT INTO content_backfill VALUES ('AAA', '2026-10-01')").run();
    reported("AAA", "2026-10-01");
    reported("ZZZ", "2026-10-20");
    expect(await job.runTranscriptJob("2026-10-21")).toMatchObject({ recent: 0, calls: 0 });
  });

  it("stops backfilling at the call budget and leaves the rest for the next run", async () => {
    watch("AAA", "BBB", "CCC");
    available = { AAA: quarters(4), BBB: quarters(4), CCC: quarters(4) };
    const r = await job.runTranscriptJob("2026-10-21", 10);
    expect(r.backfilled).toBeLessThan(3);
    expect(r.calls).toBeLessThanOrEqual(10);
    const next = await job.runTranscriptJob("2026-10-22", 10);
    expect(next.backfilled).toBeGreaterThan(0);
  });
});
