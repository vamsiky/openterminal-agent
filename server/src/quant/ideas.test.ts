import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OptionScorecard } from "../scan/contracts.js";

let tmpDir: string;
let ideas: typeof import("./ideas.js");
let db: typeof import("../db.js").db;

const NOW = new Date("2026-10-21T14:00:00Z");
const later = (min: number) => new Date(NOW.getTime() + min * 60_000);

function seedCards(scores: Record<string, number>, day = "2026-10-21", coverage = 0.9) {
  const insert = db.prepare(
    "INSERT OR REPLACE INTO scorecards (day, symbol, sector, industry, composite, groups, factors, coverage, weights_version) VALUES (?, ?, 'Technology', 'x', ?, ?, ?, ?, 'stock-v1')"
  );
  for (const [symbol, c] of Object.entries(scores)) {
    insert.run(day, symbol, c, JSON.stringify({ valuation: c, quality: c - 10, growth: 40, earnings: null, analysts: 55, momentum: c + 5 }), JSON.stringify({ pe: [10, c, null], roic: [0.2, c - 10, null], ret_6m: [0.3, 99, null] }), coverage);
  }
}

function optionCard(underlying: string, score: number | null, ivHistoryDays = 200): OptionScorecard {
  return {
    underlying, asOf: NOW.toISOString(), score, momentum: { m5: 1, m15: 2, h1: 3, d1: 4 }, metrics: { ivHistoryDays } as OptionScorecard["metrics"], earningsBeforeExpiry: null, nextEarnings: null,
    setups: score === null ? [] : [{ strategy: "long_call", score, contract: `${underlying}261120C00100000`, reasons: ["r"] }],
  };
}
function seedOptions(cards: OptionScorecard[]) {
  db.prepare("DELETE FROM option_scorecards").run();
  for (const c of cards) db.prepare("INSERT INTO option_scorecards (underlying, as_of, score, data) VALUES (?, ?, ?, ?)").run(c.underlying, c.asOf, c.score, JSON.stringify(c));
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-ideas-test-"));
  process.env.DATA_DIR = tmpDir;
  ({ db } = await import("../db.js"));
  ideas = await import("./ideas.js");
});

afterAll(async () => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

describe("stock ideas", () => {
  it("lists the top composites of the universe with reasons and drops the ones that fall out", () => {
    const names = Array.from({ length: 30 }, (_, i) => `S${String(i).padStart(2, "0")}`);
    seedCards(Object.fromEntries(names.map((n, i) => [n, 90 - i])));
    seedCards({ LOWC: 99 }, "2026-10-21", 0.4); // best score but too little data
    const universe = [...names, "LOWC"];
    expect(ideas.runStockScreen(universe, NOW)).toEqual({ listed: 25, dropped: 0 });
    const list = ideas.listIdeas({ kind: "stock" });
    expect(list).toHaveLength(25);
    expect(list[0]).toMatchObject({ symbol: "S00", rank: 1, strategy: "buy", status: "active", score: 90, firstSeen: NOW.toISOString() });
    expect(list.map((i) => i.symbol)).not.toContain("LOWC");
    expect(list[0].reasons).toHaveLength(3);
    expect(list[0].reasons[0]).toMatch(/^momentum 95\/100; best: 6-month return, 99\/100 against sector peers/);

    // S24 falls out when a better stock arrives; a stock outside the universe never lists.
    seedCards({ NEW: 95, OUT: 100 });
    expect(ideas.runStockScreen([...universe, "NEW"], later(60 * 8))).toEqual({ listed: 25, dropped: 1 });
    const again = ideas.listIdeas({ kind: "stock" });
    expect(again[0].symbol).toBe("NEW");
    const s00 = again.find((i) => i.symbol === "S00")!;
    expect(s00.firstSeen).toBe(NOW.toISOString()); // unchanged while it stays
    expect(s00.rank).toBe(2);
    expect(ideas.listIdeas({ kind: "stock", status: "dropped" }).map((i) => i.symbol)).toEqual(["S24"]);
  });

  it("words market-wide factors as against the whole market", () => {
    const card = { symbol: "S99", asOf: "", sector: "Technology", industry: null, composite: 80, groups: { momentum: 90 }, coverage: 1, weightsVersion: "stock-v2",
      factors: [{ key: "rs_spy", group: "momentum", value: 0.2, score: 97, change: null }, { key: "ret_6m", group: "momentum", value: 0.2, score: 80, change: null }] };
    expect(ideas.stockReasons(card, "2026-10-21")[0]).toBe("momentum 90/100; best: 6-month excess return over SPY, 97/100 against the whole market");
    card.factors[0].score = 50;
    expect(ideas.stockReasons(card, "2026-10-21")[0]).toBe("momentum 90/100; best: 6-month return, 80/100 against sector peers");
  });

  it("keeps one listing per company: the share class with the higher dollar volume", () => {
    const profile = db.prepare(
      `INSERT INTO bulk_profiles (symbol, company_name, exchange, sector, industry, country, price, market_cap, average_volume, is_etf, is_fund, is_adr, is_actively_trading, data, updated_at)
       VALUES (?, ?, 'NASDAQ', 'Technology', 'x', 'US', 100, 1e9, ?, 0, 0, 0, 1, ?, '')`
    );
    profile.run("GOOG", "Alphabet Inc.", 20_000_000, '{"cik":"0001652044"}');
    profile.run("GOOGL", "Alphabet Inc. Class A", 30_000_000, '{"cik":"0001652044"}');
    profile.run("NOCIK1", "Same Name Corp", 1_000_000, "{}");
    profile.run("NOCIK2", "Same Name Corp", 5_000_000, "{}");
    profile.run("LONER", "Loner", 1, "{}");
    const cards = ["GOOG", "NOCIK1", "GOOGL", "LONER", "NOCIK2", "UNKNOWN"].map((symbol) => ({ symbol }));
    expect(ideas.onePerCompany(cards).map((c) => c.symbol)).toEqual(["LONER", "NOCIK2", "GOOGL", "UNKNOWN"].sort((a, b) => cards.findIndex((c) => c.symbol === a) - cards.findIndex((c) => c.symbol === b)));
  });

  it("re-scores active stock ideas from the live cards", () => {
    db.prepare(
      "INSERT OR REPLACE INTO scorecards_live (symbol, as_of, sector, industry, composite, groups, factors, coverage, weights_version, rank) VALUES ('S01', ?, 'Technology', 'x', 99.5, '{\"momentum\":99}', '{}', 0.9, 'stock-v1', 1)"
    ).run(NOW.toISOString());
    ideas.refreshStockIdeas(later(600));
    const list = ideas.listIdeas({ kind: "stock" });
    expect(list[0]).toMatchObject({ symbol: "S01", score: 99.5, rank: 1 });
    expect(list).toHaveLength(25);
  });
});

describe("option ideas", () => {
  it("lists setups of 70+ (top 20) and drops one after two missed scans", () => {
    seedOptions([optionCard("AAA", 85), optionCard("BBB", 72), optionCard("CCC", 69), optionCard("DDD", null)]);
    expect(ideas.updateOptionIdeas(NOW)).toEqual({ listed: 2, dropped: 0 });
    let list = ideas.listIdeas({ kind: "option" });
    expect(list.map((i) => [i.symbol, i.rank, i.strategy, i.contract])).toEqual([["AAA", 1, "long_call", "AAA261120C00100000"], ["BBB", 2, "long_call", "BBB261120C00100000"]]);

    seedOptions([optionCard("AAA", 80), optionCard("BBB", 60)]); // BBB misses once
    expect(ideas.updateOptionIdeas(later(5))).toEqual({ listed: 1, dropped: 0 });
    list = ideas.listIdeas({ kind: "option" });
    expect(list.map((i) => i.symbol)).toEqual(["AAA", "BBB"]);
    expect(list[0].score).toBe(80);

    expect(ideas.updateOptionIdeas(later(10))).toEqual({ listed: 1, dropped: 1 }); // misses twice
    expect(ideas.listIdeas({ kind: "option" }).map((i) => i.symbol)).toEqual(["AAA"]);
    expect(ideas.listIdeas({ kind: "option", status: "dropped" }).map((i) => i.symbol)).toEqual(["BBB"]);

    // It comes back as a new idea.
    seedOptions([optionCard("AAA", 80), optionCard("BBB", 90)]);
    ideas.updateOptionIdeas(later(15));
    const back = ideas.listIdeas({ kind: "option" }).find((i) => i.symbol === "BBB")!;
    expect(back.firstSeen).toBe(later(15).toISOString());
    expect(back.rank).toBe(1);
  });

  it("uses 60 while IV history is under 20 days, with the reason", () => {
    seedOptions([optionCard("NEW1", 65, 5), optionCard("NEW2", 55, 5), optionCard("OLD1", 65, 200), optionCard("EDGE", 62, 20)]);
    ideas.updateOptionIdeas(later(30));
    const list = ideas.listIdeas({ kind: "option", limit: 100 });
    const new1 = list.find((i) => i.symbol === "NEW1")!;
    expect(new1.reasons).toEqual(["r", ideas.EARLY_IV_REASON]);
    expect(list.map((i) => i.symbol)).not.toContain("NEW2"); // under 60
    expect(list.map((i) => i.symbol)).not.toContain("OLD1"); // enough history, so 70 applies
    expect(list.map((i) => i.symbol)).not.toContain("EDGE"); // exactly 20 days counts as enough
  });

  it("caps the list at 20", () => {
    seedOptions(Array.from({ length: 30 }, (_, i) => optionCard(`X${String(i).padStart(2, "0")}`, 99 - i / 2)));
    ideas.updateOptionIdeas(later(20));
    const list = ideas.listIdeas({ kind: "option", limit: 100 });
    expect(list.slice(0, 20).map((i) => i.symbol)).toEqual(Array.from({ length: 20 }, (_, i) => `X${String(i).padStart(2, "0")}`));
    expect(list.slice(20).every((i) => !i.symbol.startsWith("X"))).toBe(true); // ideas that missed this scan once are carried below
  });
});

describe("share classes in the screen", () => {
  it("screens one listing per company", () => {
    seedCards({ GOOG: 95.5, GOOGL: 95.4 }, "2026-10-21");
    ideas.runStockScreen(["GOOG", "GOOGL"], later(60 * 9));
    const active = ideas.listIdeas({ kind: "stock", limit: 100 }).map((i) => i.symbol);
    expect(active).toContain("GOOGL");
    expect(active).not.toContain("GOOG");
  });
});
