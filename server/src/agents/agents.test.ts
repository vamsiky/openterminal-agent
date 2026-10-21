import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: (args: unknown) => queryMock(args) }));
const quotes: Record<string, unknown> = {};
vi.mock("../live/feed.js", () => ({ liveQuote: (s: string) => quotes[s] ?? null }));

let tmpDir: string;
let db: typeof import("../db.js").db;
let queue: typeof import("./queue.js");
let store: typeof import("./store.js");
let triggers: typeof import("./triggers.js");
let brief: typeof import("./brief.js");
let analysis: typeof import("./analysis.js");
let service: typeof import("./service.js");
let { guardrail }: typeof import("./guardrail.js") = {} as never;

const NOW = new Date("2026-10-21T22:00:00Z"); // Wednesday 18:00 New York
const DAY = "2026-10-21";

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-agents-test-"));
  process.env.DATA_DIR = tmpDir;
  ({ db } = await import("../db.js"));
  await import("../quant/ideas.js");
  await import("../quant/positions.js");
  await import("../estimates/timing.js");
  queue = await import("./queue.js");
  store = await import("./store.js");
  triggers = await import("./triggers.js");
  brief = await import("./brief.js");
  analysis = await import("./analysis.js");
  service = await import("./service.js");
  ({ guardrail } = await import("./guardrail.js"));
});
afterAll(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});
beforeEach(() => {
  queryMock.mockReset();
  for (const t of ["agent_runs", "agent_queue", "theses", "macro_reports", "briefs", "ideas", "positions", "earnings_calendar", "earnings_timing"]) db.prepare(`DELETE FROM ${t}`).run();
  for (const k of Object.keys(quotes)) delete quotes[k];
  delete process.env.AGENTS_DAILY_BUDGET_USD;
});

const idea = (id: number, kind: "stock" | "option", symbol: string, strategy: string, score: number, rank: number, contract: string | null = null) =>
  db.prepare("INSERT INTO ideas (id, kind, symbol, strategy, contract, score, rank, reasons, first_seen, last_seen, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')").run(id, kind, symbol, strategy, contract, score, rank, JSON.stringify(["momentum 90/100"]), NOW.toISOString(), NOW.toISOString());
const thesisBody = (over: Record<string, unknown> = {}) => ({
  ideaId: null, symbol: "MU", kind: "stock", strategy: "buy", contract: null, asOf: NOW.toISOString(), status: "ok", statusReason: null, verdict: "act", confidence: 70,
  horizon: "3-6 months", entry: { low: 90, high: 95, note: "" }, target: { price: 130, note: "" }, invalidation: { price: 80, condition: "" }, exitPlan: "x", catalysts: [{ date: "2026-12-17", event: "earnings" }],
  risks: [], summary: "s", bull: null, bear: null, evidence: [], inputs: { scorecardAsOf: null, optionScorecardAsOf: null, macroId: null, ideaScore: 80 }, models: { bull: null, bear: null, judge: null }, costUsd: 0.2, ...over,
}) as any;

describe("queue", () => {
  const item = (symbol: string, rank = 5, over: Record<string, unknown> = {}) => ({ symbol, strategy: "buy" as const, kind: "stock" as const, reason: "new", rank, ...over });

  it("dedupes automatic items per symbol, strategy, contract and day", () => {
    expect(queue.enqueue(item("MU"), { now: NOW })).toEqual({ position: 1 });
    expect(queue.enqueue(item("MU"), { now: NOW })).toMatchObject({ existing: true }); // pending already: reported, not queued twice
    expect(queue.enqueue({ ...item("MU"), strategy: "short_put", kind: "option", contract: "MU261120P00090000" }, { now: NOW })).not.toBeNull();
    // Automatic option items key on symbol, strategy and day, not the contract.
    expect(queue.enqueue({ ...item("MU"), strategy: "short_put", kind: "option", contract: "MU261120P00095000" }, { now: NOW })).toMatchObject({ existing: true }); // pending already: reported, not queued twice
    expect(queue.pending().find((i) => i.strategy === "short_put")?.contract).toBe("MU261120P00095000"); // follows the idea
    // Finished today: automatic items still wait for tomorrow.
    queue.markDone(queue.pending()[0].id);
    expect(queue.enqueue(item("MU"), { now: NOW })).toBeNull();
    expect(queue.enqueue(item("MU"), { now: new Date("2026-10-22T22:00:00Z") })).not.toBeNull();
  });

  it("keeps manual requests per contract", () => {
    const c = (contract: string) => ({ ...item("MU"), strategy: "short_put" as const, kind: "option" as const, contract });
    expect(queue.enqueue(c("A"), { manual: true, now: NOW })).not.toBeNull();
    expect(queue.enqueue(c("B"), { manual: true, now: NOW })).not.toBeNull();
    expect(queue.enqueue(c("A"), { manual: true, now: NOW })).not.toBeNull(); // promotes the queued one
    expect(queue.pending()).toHaveLength(2);
    expect(queue.isBusy("MU", "short_put", "B")).toBe(true);
    expect(queue.isBusy("MU", "short_put", "C")).toBe(false);
  });

  it("promotes a queued item on a manual request, and refuses only a running one", () => {
    queue.enqueue(item("A", 1), { now: NOW });
    queue.enqueue(item("MU", 9), { now: NOW });
    expect(queue.pending().map((i) => i.symbol)).toEqual(["A", "MU"]);
    expect(queue.enqueue(item("MU"), { manual: true, now: new Date(NOW.getTime() + 1000) })).toEqual({ position: 1, existing: true });
    expect(queue.pending().map((i) => [i.symbol, i.manual])).toEqual([["MU", true], ["A", false]]);
    expect(queue.pending()).toHaveLength(2);
    const id = queue.pending()[0].id;
    queue.markRunning(id);
    expect(queue.enqueue(item("MU"), { manual: true, now: NOW })).toBeNull();
    queue.markDone(id);
    expect(queue.enqueue(item("MU"), { manual: true, now: NOW })).toEqual({ position: 1 });
  });

  it("orders manual first, then held symbols, then idea rank", () => {
    db.prepare("INSERT INTO positions (kind, symbol, underlying, quantity) VALUES ('stock', 'HELD', 'HELD', 10)").run();
    queue.enqueue(item("A", 1), { now: NOW });
    queue.enqueue(item("B", 2), { now: NOW });
    queue.enqueue(item("HELD", 9), { now: NOW });
    queue.enqueue(item("MAN", 20), { manual: true, now: NOW });
    expect(queue.pending().map((i) => i.symbol)).toEqual(["MAN", "HELD", "A", "B"]);
  });

  it("survives a restart: running rows come back as queued", () => {
    queue.enqueue(item("MU"), { now: NOW });
    queue.markRunning(queue.pending()[0].id);
    db.prepare("UPDATE agent_queue SET status = 'queued' WHERE status = 'running'").run();
    expect(queue.pending()).toHaveLength(1);
  });

  it("notes a budget skip once per item and day", () => {
    queue.enqueue(item("MU"), { now: NOW });
    const id = queue.pending()[0].id;
    expect(queue.noteBudgetSkip(id, DAY)).toBe(true);
    expect(queue.noteBudgetSkip(id, DAY)).toBe(false);
    expect(queue.noteBudgetSkip(id, "2026-10-22")).toBe(true);
  });
});

describe("guardrail", () => {
  const base = { verdict: "act" as const, invalidation: { price: 80, condition: "" }, catalysts: [{ date: "2026-12-17", event: "earnings" }], strategy: "buy" as const };
  it("passes a complete act", () => expect(guardrail(base, DAY)).toBeNull());
  it("rejects act without invalidation", () => {
    expect(guardrail({ ...base, invalidation: { price: null, condition: "  " } }, DAY)).toMatch(/invalidation/);
    expect(guardrail({ ...base, invalidation: { price: null, condition: "closes below the 200-day" } }, DAY)).toBeNull();
  });
  it("rejects act without a dated catalyst on or after the thesis day", () => {
    expect(guardrail({ ...base, catalysts: [] }, DAY)).toMatch(/catalyst/);
    expect(guardrail({ ...base, catalysts: [{ date: null, event: "x" }] }, DAY)).toMatch(/catalyst/);
    expect(guardrail({ ...base, catalysts: [{ date: "2026-10-20", event: "past" }] }, DAY)).toMatch(/catalyst/);
    expect(guardrail({ ...base, catalysts: [{ date: DAY, event: "today" }] }, DAY)).toBeNull();
  });
  it("never rejects wait or pass", () => {
    expect(guardrail({ ...base, verdict: "wait", invalidation: { price: null, condition: "" }, catalysts: [] }, DAY)).toBeNull();
    expect(guardrail({ ...base, verdict: "pass", catalysts: [] }, DAY)).toBeNull();
  });
  it("rejects a covered call act without 100 shares", () => {
    expect(guardrail({ ...base, strategy: "covered_call" }, DAY, { sharesHeld: 50 })).toMatch(/shares/);
    expect(guardrail({ ...base, strategy: "covered_call" }, DAY, { sharesHeld: 100 })).toBeNull();
  });
});

describe("price warning", () => {
  const t = (over = {}) => ({ entry: { low: 90, high: 95 }, target: { price: 130 }, invalidation: { price: 80 }, ...over });
  const opt = (over = {}) => ({ entry: { low: 2.1, high: 2.3 }, target: { price: 4.6 }, invalidation: { price: 150 }, ...over });
  it("flags stock levels more than 50% from the current price, without rejecting", async () => {
    const { priceWarning } = await import("./guardrail.js");
    const ref = { underlying: 100 };
    expect(priceWarning(t(), ref)).toBeNull();
    expect(priceWarning(t({ target: { price: 160 } }), ref)).toMatch(/target 160 vs 100/);
    expect(priceWarning(t({ invalidation: { price: 40 } }), ref)).toMatch(/invalidation 40/);
    expect(priceWarning(t({ target: { price: 160 } }), { underlying: null })).toBeNull();
    expect(priceWarning({ entry: null, target: null, invalidation: null }, ref)).toBeNull();
  });
  it("checks option premiums against the contract mid and invalidation against the underlying", async () => {
    const { priceWarning } = await import("./guardrail.js");
    // ROKU-like: premium 2.30 against a stock at 157.74 is fine.
    expect(priceWarning(opt(), { underlying: 157.74, premium: 2.2, option: true })).toBeNull();
    expect(priceWarning(opt({ entry: { low: 4, high: 5 } }), { underlying: 157.74, premium: 2.2, option: true })).toMatch(/entry/);
    expect(priceWarning(opt({ target: { price: 30 } }), { underlying: 157.74, premium: 2.2, option: true })).toMatch(/target \(premium\) 30/);
    expect(priceWarning(opt({ invalidation: { price: 2 } }), { underlying: 157.74, premium: 2.2, option: true })).toMatch(/invalidation 2 vs 157.74/);
    // No contract quote: premium checks are skipped, invalidation still checked.
    expect(priceWarning(opt({ entry: { low: 40, high: 50 }, target: { price: 90 } }), { underlying: 157.74, premium: null, option: true })).toBeNull();
  });
  it("is added to a stored thesis's statusReason with status unchanged", async () => {
    quotes.MU = { price: 100, change: 0, changePercent: 0, asOf: null, extended: {} };
    queryMock.mockImplementation(({ prompt }: { prompt: string }) => (async function* () {
      yield { type: "system", subtype: "init", apiKeySource: "none", mcp_servers: [{ name: "openterminal", status: "connected" }] };
      const out = prompt.startsWith("Decide")
        ? { verdict: "wait", confidence: 50, horizon: "m", entry: { low: 90, high: 95, note: "" }, target: { price: 400, note: "" }, invalidation: { price: 80, condition: "" }, exitPlan: "x", catalysts: [], risks: [], summary: "s", evidence: [] }
        : { summary: "s", points: [{ point: "p", evidence: [] }] };
      yield { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.01, duration_ms: 1, num_turns: 1, usage: {}, structured_output: out, errors: [] };
    })());
    const r = await analysis.analyze({ symbol: "MU", strategy: "buy", contract: null, ideaId: null, kind: "stock" }, NOW);
    expect(r.outcome === "done" && r.thesis).toMatchObject({ status: "ok", verdict: "wait" });
    expect(r.outcome === "done" && r.thesis.statusReason).toMatch(/target 400/);
  });
  it("does not warn on an option thesis whose premium is near the streamed mid", async () => {
    const { setOptionQuoteSource } = await import("./option-quote.js");
    setOptionQuoteSource(() => ({ bid: 2.2, ask: 2.4, last: null }));
    quotes.ROKU = { price: 157.74, change: 0, changePercent: 0, asOf: null, extended: {} };
    queryMock.mockImplementation(({ prompt }: { prompt: string }) => (async function* () {
      yield { type: "system", subtype: "init", apiKeySource: "none", mcp_servers: [{ name: "openterminal", status: "connected" }] };
      const out = prompt.startsWith("Decide")
        ? { verdict: "wait", confidence: 50, horizon: "d", entry: { low: 2.1, high: 2.3, note: "" }, target: { price: 4.5, note: "" }, invalidation: { price: 150, condition: "" }, exitPlan: "x", catalysts: [], risks: [], summary: "s", evidence: [] }
        : { summary: "s", points: [{ point: "p", evidence: [] }] };
      yield { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.01, duration_ms: 1, num_turns: 1, usage: {}, structured_output: out, errors: [] };
    })());
    const r = await analysis.analyze({ symbol: "ROKU", strategy: "long_call", contract: "ROKU261120C00160000", ideaId: null, kind: "option" }, NOW);
    expect(r.outcome === "done" && r.thesis.statusReason).toBeNull();
    setOptionQuoteSource(null);
  });
});

describe("triggers", () => {
  it("queues ideas without a thesis, in rank order", () => {
    idea(1, "stock", "MU", "buy", 80, 1);
    idea(2, "stock", "AMD", "buy", 75, 2);
    expect(triggers.scanIdeas(NOW)).toBe(2);
    expect(triggers.scanIdeas(NOW)).toBe(0);
    expect(queue.pending().map((i) => i.symbol)).toEqual(["MU", "AMD"]);
  });

  it("skips stock ideas with a thesis in the last 7 days, requeues after that or when the score moved 10+", () => {
    idea(1, "stock", "MU", "buy", 80, 1);
    store.insertThesis(DAY, thesisBody({ asOf: "2026-10-16T12:00:00Z" }));
    const mu = () => db.prepare("SELECT * FROM ideas WHERE id = 1").get() as any;
    const asIdea = (score: number) => ({ id: 1, kind: "stock" as const, symbol: "MU", strategy: "buy" as const, contract: null, score, rank: 1, reasons: [], firstSeen: "", lastSeen: "", status: "active" as const });
    expect(mu().symbol).toBe("MU");
    expect(triggers.needsAnalysis(asIdea(85), NOW)).toBeNull();
    expect(triggers.needsAnalysis(asIdea(91), NOW)).toMatch(/moved 11 points/);
    expect(triggers.needsAnalysis(asIdea(80), new Date("2026-10-25T18:00:00Z"))).toMatch(/7 days/);
  });

  it("option ideas need a thesis from the same trading day for the same symbol and strategy, any contract", () => {
    const c = "MU261120C00100000";
    const o = { id: 3, kind: "option" as const, symbol: "MU", strategy: "long_call" as const, contract: c, score: 80, rank: 1, reasons: [], firstSeen: "", lastSeen: "", status: "active" as const };
    store.insertThesis("2026-10-20", thesisBody({ kind: "option", strategy: "long_call", contract: c, asOf: "2026-10-20T15:00:00Z" }));
    expect(triggers.needsAnalysis(o, NOW)).toMatch(/today/);
    store.insertThesis(DAY, thesisBody({ kind: "option", strategy: "long_call", contract: c }));
    expect(triggers.needsAnalysis(o, NOW)).toBeNull();
    // The contract re-centred: the day's thesis still counts.
    expect(triggers.needsAnalysis({ ...o, contract: "MU261120C00105000" }, NOW)).toBeNull();
    expect(triggers.needsAnalysis({ ...o, strategy: "short_put" }, NOW)).toMatch(/no thesis/);
  });

  it("tries again after an errored analysis", () => {
    const o = { id: 1, kind: "stock" as const, symbol: "MU", strategy: "buy" as const, contract: null, score: 80, rank: 1, reasons: [], firstSeen: "", lastSeen: "", status: "active" as const };
    store.insertThesis(DAY, thesisBody({ status: "error", statusReason: "judge failed" }));
    expect(triggers.needsAnalysis(o, NOW)).toMatch(/failed/);
  });

  it("stock analyses wait for the evening and 06:40 windows", () => {
    expect(service.stockWindowOpen(new Date("2026-10-21T21:00:00Z"))).toBe(true); // 17:00
    expect(service.stockWindowOpen(new Date("2026-10-21T19:00:00Z"))).toBe(false); // 15:00
    expect(service.stockWindowOpen(new Date("2026-10-21T10:30:00Z"))).toBe(false); // 06:30
    expect(service.stockWindowOpen(new Date("2026-10-21T10:45:00Z"))).toBe(true); // 06:45
    expect(service.stockWindowOpen(new Date("2026-10-24T21:00:00Z"))).toBe(false); // Saturday
  });
});

describe("brief inputs", () => {
  const deps = { econEvents: async () => [{ time: "2026-10-22T12:30:00Z", title: "Jobless claims", impact: "Medium", forecast: "220K", previous: "215K", actual: null }], symbols: () => ["MU", "AMD", "NVDA", "AAPL"], held: () => ["MU"] };
  const session = (price: number, changePercent: number) => ({ price, change: 1, changePercent, time: "2026-10-22T11:30:00Z", live: true });
  const NEXT = new Date("2026-10-22T11:00:00Z"); // Thursday 07:00 New York

  it("gathers macro, events, earnings, movers and ideas with theses", async () => {
    const macro = store.insertMacro("2026-10-22", "pre", { regime: { rates: "flat", risk: "on", volatility: "low", dollar: "flat", oil: "flat" }, summary: "calm", events: [], risks: ["cpi"], evidence: [] }, 0.1, NEXT);
    const cal = db.prepare("INSERT INTO earnings_calendar (symbol, report_date, eps_estimate, revenue_estimate, last_seen_day) VALUES (?, ?, ?, ?, ?)");
    cal.run("AMD", "2026-10-22", 1.1, 100, DAY);
    cal.run("NVDA", "2026-10-22", 3, 200, DAY);
    cal.run("AAPL", "2026-10-21", 2, 300, DAY); // yesterday, after the close
    cal.run("MU", "2026-10-22", 1, 50, DAY); // timing unknown
    const timing = db.prepare("INSERT INTO earnings_timing (symbol, timing, matched, total, updated_day) VALUES (?, ?, 3, 4, ?)");
    timing.run("AMD", "bmo", DAY);
    timing.run("NVDA", "amc", DAY); // reports tonight: not in today's list
    timing.run("AAPL", "amc", DAY);
    quotes.MU = { previousClose: 100, extended: { pre: session(104, 4), overnight: null, post: null } };
    quotes.AMD = { previousClose: 100, extended: { pre: null, overnight: null, post: session(99.5, -0.5) } }; // under 1%
    quotes.NVDA = { previousClose: 100, extended: { pre: session(97, -3), overnight: null, post: null } };
    idea(1, "stock", "MU", "buy", 80, 1);
    idea(2, "stock", "AMD", "buy", 70, 2);
    idea(3, "option", "NVDA", "short_put", 72, 1, "NVDA261120P00090000");
    const th = store.insertThesis(DAY, thesisBody({ ideaId: 1 }));

    const inputs = await brief.gatherBriefInputs(NEXT, [{ symbol: "AMD", strategy: "buy", state: "queued" }], deps);
    expect(inputs.macro).toMatchObject({ id: macro.id, regime: { risk: "on" } });
    expect(inputs.macroNote).toBeNull();
    expect(inputs.economicEvents).toHaveLength(1);
    expect(inputs.earnings.reportingToday.map((e) => e.symbol)).toEqual(["MU", "AMD"]); // held first, MU timing unknown
    expect(inputs.earnings.reportedAfterClose.map((e) => e.symbol)).toEqual(["AAPL"]);
    expect(inputs.movers.map((m) => [m.symbol, m.changePercent, m.session])).toEqual([["MU", 4, "pre"], ["NVDA", -3, "pre"]]);
    expect(inputs.stockIdeas[0]).toMatchObject({ symbol: "MU", held: true, analysis: "thesis", thesis: { id: th.id, verdict: "act" } });
    expect(inputs.stockIdeas[1]).toMatchObject({ symbol: "AMD", analysis: "queued", thesis: null });
    expect(inputs.optionIdeas[0]).toMatchObject({ symbol: "NVDA", analysis: "none" });
    expect(inputs.thesisIds).toEqual([th.id]);
  });

  it("says there is no macro report when none exists for the day", async () => {
    store.insertMacro("2026-10-21", "post", { regime: { rates: "flat", risk: "on", volatility: "low", dollar: "flat", oil: "flat" }, summary: "yesterday", events: [], risks: [], evidence: [] }, 0.1, NOW);
    const inputs = await brief.gatherBriefInputs(NEXT, [], deps);
    expect(inputs.macro).toBeNull();
    expect(inputs.macroNote).toBe("No macro report today");
  });

  it("survives a failing economic calendar", async () => {
    const inputs = await brief.gatherBriefInputs(NEXT, [], { ...deps, econEvents: async () => { throw new Error("down"); } });
    expect(inputs.economicEvents).toEqual([]);
    expect(inputs.economicEventsError).toBe("down");
  });

  it("writes and stores the brief through the mocked SDK", async () => {
    queryMock.mockImplementation(() => (async function* () {
      yield { type: "system", subtype: "init", apiKeySource: "ANTHROPIC_API_KEY", mcp_servers: [] };
      yield { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.03, duration_ms: 900, num_turns: 1, usage: {}, structured_output: { markdown: "## Regime\nNo macro report today.\n\n## Today's calendar\n..." }, errors: [] };
    })());
    const r = await brief.runBrief(NEXT, [], deps);
    expect(r.ok).toBe(true);
    expect(store.latestBrief()).toMatchObject({ day: "2026-10-22", costUsd: 0.03 });
    expect(queryMock.mock.calls[0][0].prompt).toContain("No macro report today");
    expect(queryMock.mock.calls[0][0].options.mcpServers).toBeUndefined();
  });
});

describe("analysis (mocked SDK end to end)", () => {
  const caseOut = { summary: "s", points: [{ point: "p", evidence: [{ claim: "c", source: "fundamentals:estimates", asOf: DAY }] }] };
  const judge = (over: Record<string, unknown> = {}) => ({
    verdict: "act", confidence: 72, horizon: "3-6 months", entry: { low: 90, high: 95, note: "zone" }, target: { price: 130, note: "t" },
    invalidation: { price: 80, condition: "" }, exitPlan: "trim at target", catalysts: [{ date: "2026-12-17", event: "earnings" }], risks: ["r"], summary: "ok", evidence: [], ...over,
  });
  const answer = (judgeOut: unknown, opts: { bullFails?: boolean } = {}) =>
    queryMock.mockImplementation(({ prompt }: { prompt: string }) =>
      (async function* () {
        yield { type: "system", subtype: "init", apiKeySource: "none", mcp_servers: [{ name: "openterminal", status: "connected" }] };
        const isJudge = prompt.startsWith("Decide");
        const failing = opts.bullFails && prompt.startsWith("Argue the BULL");
        yield failing
          ? { type: "result", subtype: "error_max_turns", is_error: true, total_cost_usd: 0.1, duration_ms: 1, num_turns: 12, usage: {}, errors: [] }
          : { type: "result", subtype: "success", is_error: false, total_cost_usd: isJudge ? 0.2 : 0.1, duration_ms: 1000, num_turns: 4, usage: {}, structured_output: isJudge ? judgeOut : caseOut, errors: [] };
      })());
  const target = { symbol: "MU", strategy: "buy" as const, contract: null, ideaId: 1, kind: "stock" as const };

  it("runs bull and bear, then the judge, and stores an ok thesis with the total cost", async () => {
    idea(1, "stock", "MU", "buy", 82, 1);
    answer(judge());
    const r = await analysis.analyze(target, NOW);
    expect(r.outcome).toBe("done");
    if (r.outcome !== "done") return;
    expect(r.thesis).toMatchObject({ status: "ok", verdict: "act", symbol: "MU", ideaId: 1, kind: "stock", inputs: { ideaScore: 82 } });
    expect(r.thesis.bull?.side).toBe("bull");
    expect(r.thesis.bear?.side).toBe("bear");
    expect(r.thesis.costUsd).toBeCloseTo(0.4);
    expect(r.thesis.models).toEqual({ bull: "claude-sonnet-5-5", bear: "claude-sonnet-5-5", judge: "claude-opus-5-5" });
    const judgeCall = queryMock.mock.calls.map((c) => c[0]).find((c) => c.prompt.startsWith("Decide"));
    expect(judgeCall.options.allowedTools).toEqual(["mcp__openterminal__quote", "mcp__openterminal__option_metrics"]);
    expect(judgeCall.options.maxTurns).toBe(3);
    expect(judgeCall.options.model).toBe("claude-opus-5-5");
    expect(judgeCall.prompt).toContain("BULL CASE");
    expect(store.latestThesisByIdea(1)?.id).toBe(r.thesis.id);
  });

  it("rejects an act without a dated catalyst but still stores it", async () => {
    answer(judge({ catalysts: [{ date: null, event: "someday" }] }));
    const r = await analysis.analyze(target, NOW);
    expect(r.outcome === "done" && r.thesis).toMatchObject({ status: "rejected", verdict: "act" });
    expect(r.outcome === "done" && r.thesis.statusReason).toMatch(/dated catalyst/);
  });

  it("does not reject a wait verdict that lacks them", async () => {
    answer(judge({ verdict: "wait", catalysts: [], invalidation: { price: null, condition: "" } }));
    const r = await analysis.analyze(target, NOW);
    expect(r.outcome === "done" && r.thesis.status).toBe("ok");
  });

  it("stores an error thesis when a case fails, without calling the judge", async () => {
    answer(judge(), { bullFails: true });
    const r = await analysis.analyze(target, NOW);
    expect(r.outcome === "done" && r.thesis).toMatchObject({ status: "error", verdict: null });
    expect(r.outcome === "done" && r.thesis.statusReason).toMatch(/bull case failed/);
    expect(queryMock.mock.calls.some((c) => c[0].prompt.startsWith("Decide"))).toBe(false);
  });

  it("stores an error thesis when the judge output is invalid", async () => {
    answer({ verdict: "maybe" });
    const r = await analysis.analyze(target, NOW);
    expect(r.outcome === "done" && r.thesis.status).toBe("error");
    expect(r.outcome === "done" && r.thesis.statusReason).toMatch(/judge failed: invalid output/);
  });

  it("leaves the work queued when the budget is spent", async () => {
    process.env.AGENTS_DAILY_BUDGET_USD = "0.1";
    answer(judge());
    expect(await analysis.analyze(target, NOW)).toEqual({ outcome: "budget" });
    expect(queryMock).not.toHaveBeenCalled();
    expect(store.skippedOn(DAY)).toBe(2);
  });

  it("drain runs queued options at once and marks the item done", async () => {
    idea(5, "option", "MU", "long_call", 75, 1, "MU261120C00100000");
    answer(judge());
    queue.enqueue({ symbol: "MU", strategy: "long_call", contract: "MU261120C00100000", ideaId: 5, kind: "option", reason: "new", rank: 1 }, { now: new Date() });
    await service.drain();
    expect(queue.pending()).toHaveLength(0);
    expect(store.listTheses({ limit: 5 })).toHaveLength(1);
    expect(service.status().auth).toBe("claude_login");
  });
});
