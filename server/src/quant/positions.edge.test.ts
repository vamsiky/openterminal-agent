import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let tmpDir: string;
let pos: typeof import("./positions.js");

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-positions-edge-test-"));
  process.env.DATA_DIR = tmpDir;
  pos = await import("./positions.js");
});

afterAll(async () => {
  const { db } = await import("../db.js");
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

describe("CSV encoding and layout", () => {
  it("skips a UTF-8 byte order before the header", () => {
    const { positions, errors } = pos.parsePositionsCsv("﻿symbol,quantity\nNVDA,10");
    expect(errors).toEqual([]);
    expect(positions).toEqual([{ kind: "stock", symbol: "NVDA", quantity: 10, cost: null, openedAt: null }]);
    // Excel writes a BOM in front of a capitalised header too.
    expect(pos.parsePositionsCsv("﻿Symbol,Quantity\nNVDA,10").errors).toEqual([]);
  });

  it("reads CRLF line endings with the same line numbers as LF", () => {
    const csv = "symbol,quantity,cost\r\nNVDA,10,5\r\nAAPL,2,3\r\n";
    const { positions, errors } = pos.parsePositionsCsv(csv);
    expect(errors).toEqual([]);
    expect(positions.map((p) => (p.kind === "stock" ? [p.symbol, p.cost] : []))).toEqual([
      ["NVDA", 5],
      ["AAPL", 3],
    ]);
    const bad = pos.parsePositionsCsv("symbol,quantity\r\nNVDA,10\r\nMSFT,x\r\n");
    expect(bad.errors.map((e) => e.line)).toEqual([3]);
  });

  it("keeps commas inside quoted fields, including quoted numbers and escaped quotes", () => {
    const csv = 'symbol,quantity,note\n"BRK.B","1,000","says ""hold"", then sell"\n"KO",5,"a, b"';
    const { positions, errors } = pos.parsePositionsCsv(csv);
    expect(errors).toEqual([]);
    expect(positions).toEqual([
      { kind: "stock", symbol: "BRK.B", quantity: 1000, cost: null, openedAt: null },
      { kind: "stock", symbol: "KO", quantity: 5, cost: null, openedAt: null },
    ]);
  });

  it("ignores blank lines but keeps physical line numbers for errors", () => {
    const csv = "\n\nsymbol,quantity\n\nNVDA,10\n\n\nAAPL,abc\n\n";
    const { positions, errors } = pos.parsePositionsCsv(csv);
    expect(positions.map((p) => (p.kind === "stock" ? p.symbol : ""))).toEqual(["NVDA"]);
    expect(errors).toEqual([{ line: 8, message: expect.stringMatching(/quantity "abc"/) }]);
  });

  it("matches headers case-insensitively, ignoring spaces, underscores and dashes", () => {
    const { positions, errors } = pos.parsePositionsCsv(" SYMBOL , QTY ,  AVG-COST , Opened_At\nnvda,4,100.5,2025-01-02");
    expect(errors).toEqual([]);
    expect(positions).toEqual([{ kind: "stock", symbol: "NVDA", quantity: 4, cost: 100.5, openedAt: "2025-01-02" }]);
  });

  it("uses the first of two columns with the same meaning", () => {
    const { positions } = pos.parsePositionsCsv("symbol,ticker,quantity\nNVDA,AAPL,3");
    expect(positions).toEqual([{ kind: "stock", symbol: "NVDA", quantity: 3, cost: null, openedAt: null }]);
  });
});

describe("option rows", () => {
  it("accepts the expiry, strike and right columns when they agree with the OCC symbol in any spelling", () => {
    const csv = "symbol,quantity,expiry,strike,right\nAAPL261120C00200000,2,11/20/2026,200.00,C\nAAPL261120C00200000,1,2026-11-20,200,call";
    const { positions, errors } = pos.parsePositionsCsv(csv);
    expect(errors).toEqual([]);
    // The two lines are the same contract, so they merge into one position.
    expect(positions).toEqual([{ kind: "option", occ: "AAPL261120C00200000", underlying: "AAPL", expiry: "2026-11-20", strike: 200, right: "call", quantity: 3, cost: null, openedAt: null }]);
  });

  it("rejects a conflict on the expiry or the right, not only the strike", () => {
    const expiry = pos.parsePositionsCsv("symbol,quantity,expiry\nAAPL261120C00200000,1,2026-11-21");
    expect(expiry.errors).toEqual([{ line: 2, message: expect.stringMatching(/conflicts/) }]);
    const right = pos.parsePositionsCsv("symbol,quantity,right\nAAPL261120C00200000,1,put");
    expect(right.errors).toEqual([{ line: 2, message: expect.stringMatching(/conflicts/) }]);
  });

  it("keeps negative quantity on options as a short, and rejects zero or fractional contracts", () => {
    const short = pos.parsePositionsCsv("symbol,quantity\nTSLA261218P00250000,-3");
    expect(short.errors).toEqual([]);
    expect(short.positions[0]).toMatchObject({ kind: "option", quantity: -3, right: "put" });
    const bad = pos.parsePositionsCsv("symbol,quantity\nTSLA261218P00250000,0\nTSLA261218P00250000,-1.5\nTSLA261218P00250000,2.0");
    expect(bad.errors.map((e) => e.line)).toEqual([2, 3]);
    expect(bad.positions).toHaveLength(1); // 2.0 is a whole number and is kept
  });

  it("rejects an option whose underlying is foreign or not a ticker", () => {
    const { errors } = pos.parsePositionsCsv("symbol,quantity,expiry,strike,right\n7203.T,1,2026-11-20,10,call\n^VIX,1,2026-11-20,10,call\nBTC-USD,1,2026-11-20,10,call");
    expect(errors.map((e) => e.line)).toEqual([2, 3, 4]);
    expect(errors.every((e) => /US-listed/.test(e.message))).toBe(true);
  });

  // isForeignSymbol lets a single-letter suffix through (BRK.B must stay valid), so "VOD.L" (London) is caught by
  // the listings check instead: a symbol that is in neither the exchange listings nor the FMP profiles is rejected.
  it("rejects a London listing such as VOD.L as an option underlying once listings are loaded", async () => {
    const { db } = await import("../db.js");
    db.prepare("INSERT INTO symbols (symbol, active) VALUES ('BRK.B', 1), ('NVDA', 1)").run();
    try {
      const csv = "symbol,quantity,expiry,strike,right\nVOD.L,1,2026-11-20,10,call\nNVDA,1,2026-11-20,10,call\nBRK.B,1,2026-11-20,10,call";
      const { errors } = pos.parsePositionsCsv(csv);
      expect(errors.map((e) => e.line)).toEqual([2]);
      expect(errors[0].message).toMatch(/US-listed/);
      expect(pos.parsePositionsCsv("symbol,quantity\nVOD.L,5").errors).toHaveLength(1);
    } finally {
      db.prepare("DELETE FROM symbols WHERE symbol IN ('BRK.B', 'NVDA')").run();
    }
  });

  it("skips the listings check while both listing tables are empty", () => {
    expect(pos.parsePositionsCsv("symbol,quantity\nVOD.L,5").errors).toEqual([]);
  });

  it("rejects an option row with a strike of zero or without a right", () => {
    expect(pos.parsePositionsCsv("symbol,quantity,expiry,strike\nNVDA,1,2026-11-20,0").errors).toHaveLength(1);
    expect(pos.parsePositionsCsv("symbol,quantity,expiry,strike\nNVDA,1,2026-11-20,100").errors).toHaveLength(1);
  });
});

describe("whole-file rejection", () => {
  it("reports every bad row across CRLF and blank lines, and imports nothing", () => {
    pos.importPositions("symbol,quantity\nKO,7");
    const csv = "symbol,quantity\r\n\r\nNVDA,10\r\n7203.T,1\r\n\r\nAAPL,1.5\r\n";
    const result = pos.importPositions(csv, "bad.csv");
    expect(result).toEqual({ errors: [{ line: 4, message: expect.stringMatching(/US-listed/) }, { line: 6, message: expect.stringMatching(/quantity/) }] });
    expect(pos.listPositions().positions.map((p) => (p.kind === "stock" ? p.symbol : p.occ))).toEqual(["KO"]);
  });

  it("re-importing replaces the snapshot and counts the import", () => {
    pos.importPositions("symbol,quantity\nNVDA,10\nAAPL,5");
    const before = pos.listPositions().importedAt;
    expect(pos.importPositions("symbol,quantity\nMSFT,2", "second.csv")).toEqual({ imported: 1 });
    const after = pos.listPositions();
    expect(after.positions.map((p) => (p.kind === "stock" ? p.symbol : p.occ))).toEqual(["MSFT"]);
    expect(after.importedAt! >= before!).toBe(true);
  });

  it("rejects a row with more cells than the header, but not trailing empty cells", () => {
    const { errors } = pos.parsePositionsCsv("symbol,quantity\nNVDA,1,000");
    expect(errors).toEqual([{ line: 2, message: expect.stringMatching(/3 cells but the header has 2/) }]);
    expect(pos.parsePositionsCsv("symbol,quantity\nNVDA,1,,\n").errors).toEqual([]);
  });

  it("rejects long and short lots of the same instrument, and still merges same-sign lots", () => {
    const { errors } = pos.parsePositionsCsv("symbol,quantity,cost\nNVDA,10,100\nNVDA,-4,110");
    expect(errors).toEqual([{ line: 3, message: "long and short lots of NVDA in one file; net them before importing" }]);
    const occ = pos.parsePositionsCsv("symbol,quantity\nAAPL261120C00200000,1\nAAPL261120C00200000,-1");
    expect(occ.errors).toHaveLength(1);
    const same = pos.parsePositionsCsv("symbol,quantity,cost\nNVDA,-1,2\nNVDA,-3,4");
    expect(same.errors).toEqual([]);
    expect(same.positions[0]).toMatchObject({ quantity: -4, cost: 3.5 });
  });
});
