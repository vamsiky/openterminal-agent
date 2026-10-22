import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const names: Record<string, string> = {
  OKA: "Acme Corp. Common Stock",
  GOOGL: "Alphabet Inc. Class A Common Stock",
  UNTC: "Unit Corporation Common Stock",
  ADRX: "Foo Holdings Ltd. American Depositary Shares",
  ORDX: "Bar plc Ordinary Shares",
  SLMBP: "SLM Corporation Depositary Shares, each representing a 1/40th Interest in a Share of 6.97% Non-Cumulative Preferred Stock, Series B",
  SIGIP: "Selective Insurance Group, Inc. Depositary Shares Each Representing a 1/1,000th Interest in a Share of 4.60% Non-Cumulative Preferred Stock, Series B",
  MBINN: "Merchants Bancorp 6.00% Fixed-Rate Subordinated Notes due 2027",
  HBANL: "Huntington Bancshares Incorporated Depositary Shares Series L Preferred",
  FITBI: "Fifth Third Bancorp Depositary Shares Series I Preferred",
  WARRX: "Baz Acquisition Corp. Warrants",
  RIGHT: "Qux Acquisition Corp. Rights",
  UNITX: "Quux Acquisition Corp. Units, each consisting of one share of Class A common stock and one-half of one warrant",
  BONDX: "Corp 5.25% Senior Notes due 2030",
  NONAME: "Lonely Corp Common Stock",
  "BRK.B": "Berkshire Hathaway Inc. Class B Common Stock",
  "REXR-PB": "Rexford Industrial Realty Inc. Series B Cumulative Preferred",
};
vi.mock("../providers/alpaca-assets.js", () => ({ allAssets: async () => Object.entries(names).filter(([s]) => s !== "NONAME").map(([symbol, name]) => ({ symbol, name, exchange: "", type: "stock" })) }));

let tmpDir: string;
let u: typeof import("./universe.js");
let db: typeof import("../db.js").db;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-universe-test-"));
  process.env.DATA_DIR = tmpDir;
  db = (await import("../db.js")).db;
  u = await import("./universe.js");
  const ins = db.prepare("INSERT INTO bulk_profiles (symbol, company_name, exchange, is_etf, is_fund, is_actively_trading, data, updated_at) VALUES (?, 'Parent Co', ?, ?, ?, ?, '{}', 'x')");
  for (const s of Object.keys(names)) ins.run(s, "NASDAQ", 0, 0, 1);
  ins.run("ETFX", "NYSE", 1, 0, 1);
  ins.run("FUNDX", "NASDAQ", 0, 1, 1);
  ins.run("DEADX", "NASDAQ", 0, 0, 0);
  ins.run("OTCX", "OTC", 0, 0, 1);
});

afterAll(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

describe("isCommonOrAdr", () => {
  it("drops preferreds, notes, bonds, warrants, rights and units, and symbols with - . /", () => {
    for (const s of ["SLMBP", "SIGIP", "MBINN", "HBANL", "FITBI", "WARRX", "RIGHT", "UNITX", "BONDX"]) expect(u.isCommonOrAdr(s, names[s]), s).toBe(false);
    expect(u.isCommonOrAdr("BRK.B", names["BRK.B"])).toBe(false);
    expect(u.isCommonOrAdr("REXR-PB", "x")).toBe(false);
    expect(u.isCommonOrAdr("AB/C", "x")).toBe(false);
  });

  it("keeps common stock, ADRs, ordinary shares and look-alike tickers by name, not by the fifth letter", () => {
    for (const s of ["OKA", "GOOGL", "UNTC", "ADRX", "ORDX"]) expect(u.isCommonOrAdr(s, names[s]), s).toBe(true);
    expect(u.isCommonOrAdr("WBI", "WaterBridge Infrastructure LLC Class A Shares Representing Limited Liability Company Interests")).toBe(true);
    expect(u.isCommonOrAdr("GJO", "Synthetic Fixed-Income Securities, Inc. on behalf of STRATS(SM) Trust for Wal-Mart Stores, Inc. Securities, Series 2004-5")).toBe(false);
    expect(u.isCommonOrAdr("ZZZZP", "Zed Zed Holdings Inc. Common Stock")).toBe(true);
  });
});

describe("earningsUniverse", () => {
  it("applies the exchange, ETF/fund, active and security-name filters, and remembers the result", async () => {
    expect(await u.earningsUniverse()).toEqual(["ADRX", "GOOGL", "OKA", "ORDX", "UNTC"]); // NONAME is not in the directories
    expect([...u.lastEarningsUniverse()!].sort()).toEqual(["ADRX", "GOOGL", "OKA", "ORDX", "UNTC"]);
    expect((await u.earningsUniverseSet()).has("OKA")).toBe(true);
  });
});
