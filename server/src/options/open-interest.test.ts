import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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
});
