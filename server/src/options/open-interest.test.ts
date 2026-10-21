import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let tmpDir: string;
let oi: typeof import("./open-interest.js");

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-oi-test-"));
  process.env.DATA_DIR = tmpDir;
  oi = await import("./open-interest.js");
});

afterAll(async () => {
  const { db } = await import("../db.js");
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

const contract = (symbol: string, underlying: string, open_interest: string | null) => ({ symbol, underlying_symbol: underlying, open_interest });

describe("open interest", () => {
  it("fetches in batches of 50 with paging, stores string OI, and fetches each underlying once a day", async () => {
    const names = Array.from({ length: 120 }, (_, i) => `U${i}`);
    const fetcher = vi.fn(async (_path: string, params: Record<string, string | undefined>) => {
      const batch = params.underlying_symbols!.split(",");
      if (batch[0] === "U0" && !params.page_token) {
        return { option_contracts: [contract("U0261120C00100000", "U0", "1500")], next_page_token: "p2" };
      }
      if (params.page_token) return { option_contracts: [contract("U0261120P00100000", "U0", "20"), contract("U0261120P00110000", "U0", null)], next_page_token: null };
      return { option_contracts: [contract(`${batch[0]}261120C00050000`, batch[0], "7")], next_page_token: null };
    });
    const stats = { requests: 0 };
    const map = await oi.ensureOpenInterest(names, "2026-10-21", "2026-12-20", stats, Date.now(), fetcher as any);
    expect(stats.requests).toBe(4); // 3 batches plus one extra page
    expect(fetcher.mock.calls[0][1]).toMatchObject({ expiration_date_gte: "2026-10-21", expiration_date_lte: "2026-12-20", limit: "10000" });
    expect(fetcher.mock.calls[0][1].underlying_symbols!.split(",")).toHaveLength(50);
    expect(map.get("U0261120C00100000")).toBe(1500);
    expect(map.get("U0261120P00100000")).toBe(20);
    expect(map.has("U0261120P00110000")).toBe(false); // null OI skipped

    await oi.ensureOpenInterest(names, "2026-10-21", "2026-12-20", stats, Date.now(), fetcher as any);
    expect(stats.requests).toBe(4); // cached for the day
    const next = await oi.ensureOpenInterest(["U0"], "2026-10-22", "2026-12-20", stats, Date.now(), fetcher as any);
    expect(stats.requests).toBe(6); // a new day fetches again
    expect(next.get("U0261120C00100000")).toBe(1500);
  });

  it("does not retry for 30 minutes after a failure", async () => {
    const t = Date.now();
    const fetcher = vi.fn(async () => {
      throw new Error("alpaca 500");
    });
    await expect(oi.ensureOpenInterest(["FAIL"], "2026-10-23", "2026-12-20", { requests: 0 }, t, fetcher as any)).rejects.toThrow("500");
    await oi.ensureOpenInterest(["FAIL"], "2026-10-23", "2026-12-20", { requests: 0 }, t + 60_000, fetcher as any);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(oi.ensureOpenInterest(["FAIL"], "2026-10-23", "2026-12-20", { requests: 0 }, t + 31 * 60_000, fetcher as any)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  beforeEach(() => oi.resetOpenInterestBackoff());

  const err422 = (body: string) => new Error(`alpaca 422 for /v2/options/contracts: ${body}`);

  it("drops symbols a 422 names, retries the batch once, and remembers them for the day", async () => {
    const stats = { requests: 0 };
    const fetcher = vi.fn(async (_p: string, params: Record<string, string | undefined>) => {
      const batch = params.underlying_symbols!.split(",");
      if (batch.includes("DOGE")) throw err422('{"message":"invalid underlying symbols: DOGE"}');
      return { option_contracts: batch.map((u) => contract(`${u}261120C00100000`, u, "300")), next_page_token: null };
    });
    const map = await oi.ensureOpenInterest(["AAA", "DOGE", "BBB"], "2026-10-26", "2026-12-20", stats, Date.now(), fetcher as any);
    expect(stats.requests).toBe(2);
    expect(map.get("AAA261120C00100000")).toBe(300);
    expect(map.get("BBB261120C00100000")).toBe(300);
    expect([...oi.rejectedFor("2026-10-26")]).toEqual(["DOGE"]);
    expect(oi.rejectedFor("2026-10-27").size).toBe(0);
    // Rejected symbols are not asked again that day, and the rest are cached.
    await oi.ensureOpenInterest(["AAA", "DOGE", "BBB", "CCC"], "2026-10-26", "2026-12-20", stats, Date.now(), fetcher as any);
    expect(stats.requests).toBe(3);
    expect(fetcher.mock.calls[2][1].underlying_symbols).toBe("CCC");
  });

  it("splits the batch in half when a 422 names no symbols", async () => {
    const stats = { requests: 0 };
    const names = Array.from({ length: 50 }, (_, i) => `S${i}`);
    const fetcher = vi.fn(async (_p: string, params: Record<string, string | undefined>) => {
      const batch = params.underlying_symbols!.split(",");
      if (batch.includes("S37")) throw err422('{"message":"bad request"}');
      return { option_contracts: batch.map((u) => contract(`${u}261120C00100000`, u, "250")), next_page_token: null };
    });
    const map = await oi.ensureOpenInterest(names, "2026-10-28", "2026-12-20", stats, Date.now(), fetcher as any);
    expect([...oi.rejectedFor("2026-10-28")]).toEqual(["S37"]);
    expect(map.size).toBe(49);
    expect(map.has("S37261120C00100000")).toBe(false);
    // 1 full batch + log2(50) levels of two halves, at most.
    expect(stats.requests).toBeLessThanOrEqual(1 + 2 * 6);
  });

  it("parses the names a 422 gives", () => {
    expect(oi.invalidSymbols('alpaca 422: {"message":"invalid underlying symbols: DOGE, XRP"}')).toEqual(["DOGE", "XRP"]);
    expect(oi.invalidSymbols("alpaca 422: bad request")).toEqual([]);
  });
});
