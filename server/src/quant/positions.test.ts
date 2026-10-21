import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let tmpDir: string;
let pos: typeof import("./positions.js");

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-positions-test-"));
  process.env.DATA_DIR = tmpDir;
  pos = await import("./positions.js");
});

afterAll(async () => {
  const { db } = await import("../db.js");
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

describe("parsePositionsCsv", () => {
  it("reads stocks and options in the documented layout", () => {
    const csv = [
      "symbol,quantity,cost,opened_at,type,expiry,strike,right",
      "NVDA,150,98.5,2025-03-01,,,,",
      "AAPL261120C00200000,2,4.35,2026-09-15,,,,",
      "TSLA,-1,6.1,,option,2026-12-18,250,put",
    ].join("\n");
    const { positions, errors } = pos.parsePositionsCsv(csv);
    expect(errors).toEqual([]);
    expect(positions).toEqual([
      { kind: "stock", symbol: "NVDA", quantity: 150, cost: 98.5, openedAt: "2025-03-01" },
      { kind: "option", occ: "AAPL261120C00200000", underlying: "AAPL", expiry: "2026-11-20", strike: 200, right: "call", quantity: 2, cost: 4.35, openedAt: "2026-09-15" },
      { kind: "option", occ: "TSLA261218P00250000", underlying: "TSLA", expiry: "2026-12-18", strike: 250, right: "put", quantity: -1, cost: 6.1, openedAt: null },
    ]);
  });

  it("accepts broker header aliases, spaces in OCC symbols, $ and US dates", () => {
    const csv = 'Ticker,Qty,Avg Cost,Date Acquired\nbrk.b,"1,000",$410.25,3/4/2024\nAAPL  261120P00190000,(3),"$2.10",11/02/26';
    const { positions, errors } = pos.parsePositionsCsv(csv);
    expect(errors).toEqual([]);
    expect(positions[0]).toMatchObject({ kind: "stock", symbol: "BRK.B", quantity: 1000, cost: 410.25, openedAt: "2024-03-04" });
    expect(positions[1]).toMatchObject({ kind: "option", occ: "AAPL261120P00190000", quantity: -3, cost: 2.1, openedAt: "2026-11-02" });
  });

  it("merges lots of the same instrument", () => {
    const { positions } = pos.parsePositionsCsv("symbol,quantity,cost,opened_at\nMSFT,100,300,2025-01-01\nMSFT,300,400,2024-06-01");
    expect(positions).toEqual([{ kind: "stock", symbol: "MSFT", quantity: 400, cost: 375, openedAt: "2024-06-01" }]);
  });

  it("reports every bad row with its line number", () => {
    const csv = ["symbol,quantity,cost,opened_at", "NVDA,abc,10,", "7203.T,5,10,", "AAPL,5,-1,", "MSFT,5,10,2026-02-31", "TSLA,0,10,", "KO,2,50,"].join("\n");
    const { errors } = pos.parsePositionsCsv(csv);
    expect(errors.map((e) => e.line)).toEqual([2, 3, 4, 5, 6]);
    expect(errors[1].message).toMatch(/US-listed/);
  });

  it("rejects fractional quantities and an OCC symbol that disagrees with the legs", () => {
    expect(pos.parsePositionsCsv("symbol,quantity\nNVDA,1.5").errors).toHaveLength(1);
    const csv = "symbol,quantity,strike\nAAPL261120C00200000,1,205";
    expect(pos.parsePositionsCsv(csv).errors[0].message).toMatch(/conflicts/);
    expect(pos.parsePositionsCsv("symbol,quantity,strike,right\nAAPL261120C00200000,1,200,call").errors).toEqual([]);
  });

  it("rejects an option row missing its legs, and files without the required columns", () => {
    expect(pos.parsePositionsCsv("symbol,quantity,type\nAAPL,1,option").errors[0].message).toMatch(/OCC symbol/);
    expect(pos.parsePositionsCsv("name,shares\nx,1").errors[0]).toEqual({ line: 1, message: expect.stringMatching(/symbol and quantity/) });
    expect(pos.parsePositionsCsv("").errors).toHaveLength(1);
  });
});

describe("importPositions", () => {
  it("replaces the snapshot and records the import", () => {
    expect(pos.importPositions("symbol,quantity\nNVDA,100\nAAPL261120C00200000,1", "a.csv")).toEqual({ imported: 2 });
    expect(pos.importPositions("symbol,quantity\nKO,10", "b.csv")).toEqual({ imported: 1 });
    const { positions, importedAt } = pos.listPositions();
    expect(positions.map((p) => (p.kind === "stock" ? p.symbol : p.occ))).toEqual(["KO"]);
    expect(importedAt).not.toBeNull();
  });

  it("leaves the previous snapshot alone when a row is invalid", () => {
    const result = pos.importPositions("symbol,quantity\nNVDA,100\nBAD!,1");
    expect(result).toEqual({ errors: [{ line: 3, message: expect.any(String) }] });
    expect(pos.listPositions().positions).toHaveLength(1);
  });

  it("answers holdings queries", () => {
    pos.importPositions("symbol,quantity\nNVDA,250\nAAPL261120C00200000,-2\nTSLA261218P00250000,1\nNVDA261120C00300000,1");
    expect(pos.heldSymbols()).toEqual(["AAPL", "NVDA", "TSLA"]);
    expect(pos.sharesHeld("NVDA")).toBe(250);
    expect(pos.sharesHeld("AAPL")).toBe(0);
    expect(pos.stockHoldings()).toHaveLength(1);
    expect(pos.optionHoldings().map((o) => o.quantity).sort()).toEqual([-2, 1, 1]);
  });
});
