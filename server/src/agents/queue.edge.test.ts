import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Queue edge cases: the per-day dedupe keys, how a queued option follows its idea's contract, and the
// three-day expiry of automatic items. The existing agents tests cover ordering and restarts.

let tmpDir: string;
let db: typeof import("../db.js").db;
let queue: typeof import("./queue.js");
let pos: typeof import("../quant/positions.js");

const NOW = new Date("2026-10-21T22:00:00Z"); // Wednesday 18:00 New York
const dayAt = (offset: number) => new Date(NOW.getTime() + offset * 86_400_000);

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-agents-queue-edge-"));
  process.env.DATA_DIR = tmpDir;
  ({ db } = await import("../db.js"));
  await import("./store.js"); // creates the agent tables
  queue = await import("./queue.js");
  pos = await import("../quant/positions.js");
});
afterAll(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});
beforeEach(() => {
  db.prepare("DELETE FROM agent_queue").run();
  db.prepare("DELETE FROM positions").run();
});

const stock = (symbol: string) => ({ symbol, strategy: "buy" as const, kind: "stock" as const, reason: "no thesis yet", rank: 1 });
const option = (symbol: string, strategy: "long_call" | "short_put" | "covered_call", contract: string | null) => ({
  symbol, strategy, contract, kind: "option" as const, reason: "no thesis today", rank: 3,
});

describe("stock dedupe", () => {
  it("queues a stock once per day", () => {
    expect(queue.enqueue(stock("AAA"), { now: NOW })).toEqual({ position: 1 });
    expect(queue.enqueue(stock("AAA"), { now: NOW })).toBeNull();
    queue.markDone(queue.pending().length ? queue.pending()[0].id : (db.prepare("SELECT id FROM agent_queue WHERE symbol = 'AAA'").pluck().get() as number));
    expect(queue.enqueue(stock("AAA"), { now: NOW })).toBeNull(); // done today: no second run the same day
  });

  // BUG: the dedupe is documented as per (symbol, strategy, contract, day), but the "already queued" check in
  // queue.ts enqueue() ignores the day. An automatic stock item still queued from yesterday blocks today's
  // enqueue, so today's idea is not queued at all. Expected: today's item is added (position 1).
  it.fails("queues a stock on a new day even while yesterday's item is still waiting", () => {
    queue.enqueue(stock("AAA"), { now: NOW });
    expect(queue.enqueue(stock("AAA"), { now: dayAt(1) })).toEqual({ position: 1 });
  });

  it("does not let a finished item for the day queue again the same day", () => {
    queue.enqueue(stock("BBB"), { now: NOW });
    queue.markDone(queue.pending()[0].id);
    expect(queue.enqueue(stock("BBB"), { now: NOW })).toBeNull();
  });
});

describe("option dedupe key (symbol, strategy, day)", () => {
  it("refuses a second automatic option of the same strategy on the day, whatever the contract", () => {
    expect(queue.enqueue(option("NVDA", "long_call", "NVDA261120C00300000"), { now: NOW })).not.toBeNull();
    expect(queue.enqueue(option("NVDA", "long_call", "NVDA261120C00310000"), { now: NOW })).toBeNull();
  });

  it("lets a different strategy or symbol on the same day through", () => {
    queue.enqueue(option("NVDA", "long_call", "NVDA261120C00300000"), { now: NOW });
    expect(queue.enqueue(option("NVDA", "short_put", "NVDA261120P00280000"), { now: NOW })).not.toBeNull();
    expect(queue.enqueue(option("AMD", "long_call", "AMD261120C00200000"), { now: NOW })).not.toBeNull();
  });

  it("makes a queued automatic option follow the idea's latest contract", () => {
    queue.enqueue(option("NVDA", "long_call", "NVDA261120C00300000"), { now: NOW });
    queue.enqueue(option("NVDA", "long_call", "NVDA261120C00320000"), { now: NOW });
    expect(queue.pending()[0]).toMatchObject({ symbol: "NVDA", contract: "NVDA261120C00320000" });
  });

  it("allows the same option again on the next day once the first has finished", () => {
    queue.enqueue(option("NVDA", "long_call", "NVDA261120C00300000"), { now: NOW });
    queue.markDone(queue.pending().length ? queue.pending()[0].id : (db.prepare("SELECT id FROM agent_queue WHERE symbol = 'NVDA'").pluck().get() as number));
    expect(queue.enqueue(option("NVDA", "long_call", "NVDA261120C00300000"), { now: dayAt(1) })).not.toBeNull();
  });
});

describe("expiry of automatic items", () => {
  it("drops automatic items from more than three days ago and keeps those from three days ago", () => {
    queue.enqueue(stock("OLD4"), { now: dayAt(-4) }); // 2026-10-17
    queue.enqueue(stock("OLD3"), { now: dayAt(-3) }); // 2026-10-18
    queue.enqueue(stock("TODAY"), { now: NOW });
    const dropped = queue.pruneStale(NOW);
    expect(dropped).toBe(1);
    const left = queue.pending().map((i) => i.symbol).sort();
    expect(left).toEqual(["OLD3", "TODAY"]);
  });

  it("never drops a manual request, however old", () => {
    queue.enqueue({ ...stock("MANUAL"), reason: "requested" }, { manual: true, now: dayAt(-10) });
    expect(queue.pruneStale(NOW)).toBe(0);
    expect(queue.pending().map((i) => i.symbol)).toEqual(["MANUAL"]);
  });

  it("leaves running items alone", () => {
    queue.enqueue(stock("RUN"), { now: dayAt(-6) });
    queue.markRunning(queue.pending()[0].id);
    expect(queue.pruneStale(NOW)).toBe(0);
    expect(queue.running().map((i) => i.symbol)).toEqual(["RUN"]);
  });
});

describe("held symbols first", () => {
  it("puts a held stock ahead of a better-ranked idea that is not held", () => {
    pos.importPositions("symbol,quantity\nHELD,10");
    queue.enqueue({ ...stock("STRONG"), rank: 1 }, { now: NOW });
    queue.enqueue({ ...stock("HELD"), rank: 20 }, { now: NOW });
    expect(queue.pending().map((i) => i.symbol)).toEqual(["HELD", "STRONG"]);
    db.prepare("DELETE FROM positions").run();
  });
});
