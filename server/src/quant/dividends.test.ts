import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let tmpDir: string;
let div: typeof import("./dividends.js");
let db: typeof import("../db.js").db;

const NOW = new Date("2026-10-21T14:00:00Z");

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-dividends-test-"));
  process.env.DATA_DIR = tmpDir;
  ({ db } = await import("../db.js"));
  await import("./universe.js"); // creates scan_settings
  div = await import("./dividends.js");
});

afterAll(async () => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

describe("dividend calendar", () => {
  it("fetches once a day, stores ex-dates and answers the next one per symbol", async () => {
    let calls = 0;
    const fetch = async (from: string, to: string) => {
      calls++;
      expect([from, to]).toEqual(["2026-10-21", "2026-12-20"]);
      return [
        { symbol: "KO", date: "2026-11-28", dividend: 0.51 },
        { symbol: "KO", date: "2026-12-14", adjDividend: 0.51 },
        { symbol: "BRK-B", date: "2026-11-03", dividend: 1 },
        { symbol: "BAD", date: null },
      ];
    };
    expect(await div.refreshDividends(NOW, fetch)).toBe(3);
    expect(await div.refreshDividends(NOW, fetch)).toBeNull(); // already today
    expect(calls).toBe(1);
    expect(Object.fromEntries(div.nextExDividends(["KO", "BRK.B", "NOPE"], "2026-10-21"))).toEqual({ KO: "2026-11-28", "BRK.B": "2026-11-03" });
    expect(div.nextExDividends(["KO"], "2026-11-29").get("KO")).toBe("2026-12-14");
  });

  it("keeps the old calendar when the fetch fails", async () => {
    const next = new Date(NOW.getTime() + 86_400_000);
    expect(await div.refreshDividends(next, async () => { throw new Error("boom"); })).toBeNull();
    expect(div.nextExDividends(["KO"], "2026-10-21").get("KO")).toBe("2026-11-28");
  });
});
