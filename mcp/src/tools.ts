import { z } from "zod";
import { apiGet, ApiError, type ApiConfig, type Params } from "./api.js";

export interface Tool {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  run(args: any, cfg: ApiConfig): Promise<unknown>;
}

const symbol = z.string().min(1).max(12).describe("US-listed ticker, e.g. AAPL or BRK.B. Foreign listings (SAP.DE) are rejected; use the ADR (SAP).");
const limit = z.number().int().min(1).max(1000).optional().describe("Max rows to return (newest first unless stated).");
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const enc = encodeURIComponent;

/** Pick the defined entries of `args` named in `keys`. */
const pick = (args: Record<string, unknown>, keys: string[]): Params =>
  Object.fromEntries(keys.filter((k) => args[k] !== undefined).map((k) => [k, args[k] as string | number]));

/** Paths for sections whose route is `/api/research/:symbol/<segment>`. */
function section<S extends string>(sections: Record<S, string>, name: S, sym: string) {
  return `/api/research/${enc(sym)}/${sections[name]}`;
}

/** The analysts route now applies `limit` to `grades`; this keeps the cap for a server that predates that. */
function capGrades(body: any, n: number) {
  if (Array.isArray(body?.data?.grades)) body.data.grades = body.data.grades.slice(0, n);
  return body;
}

const PROFILE_FIELDS = [
  "symbol", "companyName", "sector", "industry", "exchange", "country", "currency", "ipoDate", "ceo", "website", "isEtf", "isAdr",
  "price", "marketCap", "beta", "range", "volume", "averageVolume", "lastDividend", "fullTimeEmployees",
];

const FUNDAMENTALS = {
  statements: "statements",
  metrics: "metrics",
  growth: "growth",
  scores: "scores",
  segments: "segments",
  estimates: "estimates",
  analysts: "analysts",
  valuation: "valuation",
  peers: "peers",
} as const;

const OWNERSHIP = { institutional: "institutional", insiders: "insiders", congress: "congress", float: "float" } as const;
const CONTENT = { "press-releases": "press-releases", news: "news", filings: "filings" } as const;

const MARKET: Record<string, { path: string; params: string[]; help: string }> = {
  ipos: { path: "ipos", params: ["from", "to"], help: "IPO calendar with prospectus data and estimated lock-up expiry. from/to YYYY-MM-DD (default ±30 days)." },
  lockups: { path: "lockups", params: ["days"], help: "IPOs whose estimated 180-day lock-up expires within the next `days` (1-180, default 30)." },
  mergers: { path: "mergers", params: ["limit"], help: "Latest M&A filings. limit 1-1000." },
  splits: { path: "splits", params: ["from", "to"], help: "Stock split calendar, from/to (default today..+30d)." },
  dividends: { path: "dividends", params: ["from", "to"], help: "Dividend calendar (ex-dates), from/to (default today..+30d)." },
  sectors: { path: "sectors", params: ["date", "exchange"], help: "Sector performance and P/E for a day. date YYYY-MM-DD (default latest), exchange NASDAQ|NYSE." },
  industries: { path: "industries", params: ["date", "exchange"], help: "Industry performance and P/E for a day. Same params as sectors." },
  index: { path: "index/:name", params: ["name"], help: "Index constituents. name = sp500 | nasdaq (Nasdaq-100) | dowjones." },
  "index-changes": { path: "index/:name/changes", params: ["name", "from", "to", "limit"], help: "Index additions/removals. name = sp500 | nasdaq | dowjones." },
  "etf-holdings": { path: "etf/:symbol/holdings", params: ["symbol", "limit"], help: "Holdings of an ETF, heaviest first. symbol = the ETF ticker (e.g. SPY)." },
  "etf-exposure": { path: "etf/:symbol/exposure", params: ["symbol"], help: "ETF info plus country and sector weightings. symbol = the ETF ticker." },
  "insiders-latest": { path: "insiders/latest", params: ["limit"], help: "Latest insider trades across all issuers. limit 1-1000." },
  "congress-latest": { path: "congress/latest", params: ["limit"], help: "Latest Senate and House trade disclosures. limit 1-1000." },
  "institutional-latest": { path: "institutional/latest-filings", params: ["limit"], help: "Latest 13F filings. limit 1-1000." },
  "press-releases-latest": { path: "press-releases/latest", params: ["limit"], help: "Latest press releases across all companies. limit 1-1000." },
  "filings-8k-latest": { path: "filings/8k/latest", params: ["limit", "from", "to"], help: "Latest 8-K filings (default last 7 days)." },
  datasets: { path: "datasets", params: [], help: "Status of the bulk datasets behind `screen` (row counts, last update)." },
};
const MARKET_SECTIONS = Object.keys(MARKET) as [string, ...string[]];

const SCREEN_FIELDS = [
  "symbol", "companyName", "exchange", "sector", "industry", "country", "isAdr", "price", "marketCap", "beta", "averageVolume",
  "priceToEarningsRatioTTM", "priceToEarningsGrowthRatioTTM", "priceToBookRatioTTM", "priceToSalesRatioTTM", "priceToFreeCashFlowRatioTTM",
  "netIncomePerShareTTM", "dividendYieldTTM", "dividendPayoutRatioTTM", "grossProfitMarginTTM", "operatingProfitMarginTTM", "netProfitMarginTTM",
  "debtToEquityRatioTTM", "currentRatioTTM", "enterpriseValueTTM", "evToEBITDATTM", "evToSalesTTM", "netDebtToEBITDATTM", "returnOnEquityTTM",
  "returnOnAssetsTTM", "returnOnInvestedCapitalTTM", "earningsYieldTTM", "freeCashFlowYieldTTM", "growthRevenue", "growthEPS", "growthFiscalYear",
  "rating", "overallScore", "lastQuarterAvgPriceTarget", "lastYearAvgPriceTarget", "upsidePercent", "consensus", "dcf",
] as const;

const periodSchema = z.enum(["quarter", "annual", "ttm"]).optional();

export const tools: Tool[] = [
  {
    name: "research_summary",
    description:
      "One-call overview of a US-listed stock: profile, live quote, TTM metrics, valuation (DCF), analyst consensus/targets, next earnings date and estimate revisions. " +
      "Start here, then use `fundamentals`, `ownership`, `transcripts`, `content` for detail. Profile is trimmed to key fields (use `market`/research routes for executives and descriptions). A section that failed is reported as {error} without failing the whole call.",
    shape: { symbol },
    async run({ symbol: s }, cfg) {
      const sym = String(s).toUpperCase();
      const base = `/api/research/${enc(sym)}`;
      // The server's own one-call snapshot, once it exists; the composition below covers older servers.
      try {
        return await apiGet(cfg, base);
      } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 404) throw err;
      }
      const parts: Record<string, () => Promise<any>> = {
        profile: async () => {
          const body = await apiGet(cfg, `${base}/profile`);
          const p = body?.data?.profile ?? {};
          return { data: Object.fromEntries(PROFILE_FIELDS.filter((k) => k in p).map((k) => [k, p[k]])) };
        },
        quote: () => apiGet(cfg, "/api/quotes", { symbols: sym }),
        metricsTtm: () => apiGet(cfg, `${base}/metrics`, { period: "ttm", limit: 1 }),
        valuation: () => apiGet(cfg, `${base}/valuation`),
        analysts: async () => capGrades(await apiGet(cfg, `${base}/analysts`, { limit: 5 }), 5),
        estimates: () => apiGet(cfg, `${base}/estimates`, { period: "annual", limit: 3 }),
        nextEarnings: () => apiGet(cfg, "/api/calendar", { symbols: sym }),
      };
      const names = Object.keys(parts);
      const settled = await Promise.allSettled(names.map((n) => parts[n]()));
      const out: Record<string, unknown> = { symbol: sym };
      const failures: ApiError[] = [];
      settled.forEach((r, i) => {
        if (r.status === "fulfilled") out[names[i]] = r.value?.data ?? r.value;
        else {
          out[names[i]] = { error: r.reason instanceof Error ? r.reason.message : String(r.reason) };
          failures.push(r.reason);
        }
      });
      // Every part failing the same way (bad symbol, API down, no key) is the caller's error, not a partial result.
      if (failures.length === names.length) throw failures[0];
      return out;
    },
  },
  {
    name: "fundamentals",
    description:
      "Company fundamentals from FMP. `section`: " +
      "statements (needs `type` income|balance|cashflow, default income; `period` quarter|annual|ttm, default quarter); " +
      "metrics (key metrics + ratios, nested as keyMetrics/ratios; period quarter|annual|ttm); " +
      "growth (income/balance/cashflow/financial growth, decimals; quarter|annual); " +
      "scores (Altman Z, Piotroski, enterprise values); " +
      "segments (revenue by product and geography; quarter|annual); " +
      "estimates (analyst consensus by period, oldest first from the latest unreported period, plus the app's tracked next-report snapshot; quarter|annual); " +
      "analysts (price targets, grade changes, consensus, rating); " +
      "valuation (DCF and levered DCF); peers (similar companies). Rows are newest first. `limit` caps rows per series.",
    shape: {
      symbol,
      section: z.enum(Object.keys(FUNDAMENTALS) as [keyof typeof FUNDAMENTALS, ...(keyof typeof FUNDAMENTALS)[]]),
      period: periodSchema.describe("quarter (default), annual or ttm. ttm is invalid for growth, segments and estimates."),
      type: z.enum(["income", "balance", "cashflow"]).optional().describe("Only for section=statements."),
      limit,
    },
    async run(a, cfg) {
      const body = await apiGet(cfg, section(FUNDAMENTALS, a.section, a.symbol), {
        ...pick(a, ["period", "limit"]),
        ...(a.section === "statements" ? pick(a, ["type"]) : {}),
      });
      return a.section === "analysts" ? capGrades(body, a.limit ?? 20) : body;
    },
  },
  {
    name: "ownership",
    description:
      "Who owns and trades the stock. `section`: institutional (13F holders for the latest filed quarter plus position summary), " +
      "insiders (Form 4 trades), congress (Senate/House trades), float (shares outstanding and free float).",
    shape: {
      symbol,
      section: z.enum(["institutional", "insiders", "congress", "float"]),
      year: z.number().int().min(2000).max(2100).optional().describe("institutional only; give with `quarter`. Default: newest quarter with complete 13F filings."),
      quarter: z.number().int().min(1).max(4).optional().describe("institutional only; give with `year`."),
      limit: limit.describe("insiders and congress only (default 50)."),
    },
    run: (a, cfg) =>
      apiGet(cfg, section(OWNERSHIP, a.section, a.symbol), a.section === "institutional" ? pick(a, ["year", "quarter"]) : a.section === "float" ? {} : pick(a, ["limit"])),
  },
  {
    name: "transcripts",
    description:
      "Earnings call transcripts. Without `year` and `quarter`: lists the available transcripts (fiscalYear, quarter, date), newest first. " +
      "With both: returns that transcript's full text (long; truncated to the size limit with a note). Use `search_transcripts` to find a topic first.",
    shape: {
      symbol,
      year: z.number().int().min(1990).max(2100).optional().describe("Fiscal year, with `quarter`."),
      quarter: z.number().int().min(1).max(4).optional().describe("Fiscal quarter 1-4, with `year`."),
    },
    run(a, cfg) {
      if ((a.year === undefined) !== (a.quarter === undefined)) {
        throw new ApiError("give both year and quarter, or neither to list the available transcripts");
      }
      const base = `/api/research/${enc(String(a.symbol))}/transcripts`;
      return apiGet(cfg, a.year === undefined ? base : `${base}/${a.year}/${a.quarter}`);
    },
  },
  {
    name: "search_transcripts",
    description:
      "Search the stored earnings call transcripts of one stock. Every word of `query` must appear (AND, case-insensitive). " +
      "Returns snippets with fiscalYear/quarter; then call `transcripts` for the full text. Only transcripts already fetched are searched, so list/fetch recent ones first if results look thin.",
    shape: { symbol, query: z.string().min(1).max(200), limit: z.number().int().min(1).max(50).optional() },
    run: (a, cfg) => apiGet(cfg, `/api/research/${enc(a.symbol)}/transcripts/search`, { q: a.query, ...pick(a, ["limit"]) }),
  },
  {
    name: "content",
    description:
      "Company text feeds. `section`: press-releases (full text, default 20), news (articles), filings (SEC filings with EDGAR links; `type` filters e.g. 8-K, 10-K, 10-Q, 4). " +
      "Dates are YYYY-MM-DD; press release/news times are New York wall time.",
    shape: {
      symbol,
      section: z.enum(["press-releases", "news", "filings"]),
      type: z.string().min(1).max(20).optional().describe("Only for filings: form type such as 8-K, 10-K, 10-Q."),
      from: day.optional(),
      to: day.optional(),
      limit,
    },
    run: (a, cfg) =>
      apiGet(cfg, section(CONTENT, a.section, a.symbol), {
        ...pick(a, ["from", "to", "limit"]),
        ...(a.section === "filings" ? pick(a, ["type"]) : {}),
      }),
  },
  {
    name: "quote",
    description: "Live quotes for up to 50 symbols (price, change, volume, market cap, P/E and more). US-listed symbols; foreign ones are dropped.",
    shape: { symbols: z.array(symbol).min(1).max(50) },
    run: (a, cfg) => apiGet(cfg, "/api/quotes", { symbols: a.symbols.join(",") }),
  },
  {
    name: "price_history",
    description: "OHLCV candles for a symbol over a range. range: 1D, 5D, 1M, 6M (default), YTD, 1Y, 5Y, MAX. Longer ranges are daily bars.",
    shape: { symbol, range: z.enum(["1D", "5D", "1M", "6M", "YTD", "1Y", "5Y", "MAX"]).optional() },
    run: (a, cfg) => apiGet(cfg, `/api/history/${enc(a.symbol)}`, { range: a.range ?? "6M" }),
  },
  {
    name: "earnings_calendar",
    description: "Next earnings report date and before/after-market timing for up to 100 symbols, with consensus EPS and revenue where known.",
    shape: { symbols: z.array(symbol).min(1).max(100) },
    run: (a, cfg) => apiGet(cfg, "/api/calendar", { symbols: a.symbols.join(",") }),
  },
  {
    name: "estimate_revisions",
    description:
      "How consensus EPS and revenue for the next report moved over the last 7/30/60/90 days (percent), plus the daily snapshot history. " +
      "Only symbols the app has tracked; otherwise `next` is null.",
    shape: { symbol },
    run: (a, cfg) => apiGet(cfg, `/api/estimates/${enc(a.symbol)}`),
  },
  {
    name: "economic_calendar",
    description: "Upcoming US macro releases (CPI, jobs, FOMC, GDP...) with forecast/previous/actual where available.",
    shape: {},
    run: (_a, cfg) => apiGet(cfg, "/api/econ-calendar"),
  },
  {
    name: "market",
    description:
      "Market-wide datasets. `section` and its `params`:\n" +
      Object.entries(MARKET).map(([k, v]) => `- ${k}: ${v.help} params: ${v.params.length ? v.params.join(", ") : "none"}`).join("\n"),
    shape: {
      section: z.enum(MARKET_SECTIONS),
      params: z
        .record(z.union([z.string(), z.number()]))
        .optional()
        .describe("Query/path params for the section, e.g. {\"name\":\"sp500\"} or {\"from\":\"2026-11-01\",\"to\":\"2026-11-30\"}. Unknown keys are rejected."),
    },
    run(a, cfg) {
      const def = MARKET[a.section];
      const given: Record<string, string | number> = a.params ?? {};
      const unknown = Object.keys(given).filter((k) => !def.params.includes(k));
      if (unknown.length) throw new ApiError(`unknown params for ${a.section}: ${unknown.join(", ")}. Allowed: ${def.params.join(", ") || "none"}`);
      let path = def.path;
      for (const p of ["name", "symbol"]) {
        if (path.includes(`:${p}`)) {
          if (given[p] === undefined) throw new ApiError(`${a.section} needs params.${p}`);
          path = path.replace(`:${p}`, enc(String(given[p])));
        }
      }
      const query = Object.fromEntries(Object.entries(given).filter(([k]) => k !== "name" && k !== "symbol"));
      return apiGet(cfg, `/api/research/market/${path}`, query);
    },
  },
  {
    name: "screen",
    description:
      "Screen the US stock universe (about 4,000 listed stocks from daily bulk data, ETFs excluded). All filters optional and ANDed. " +
      "Units: growth and dividend yield are fractions (0.2 = 20%); upsideMin is percent. Default exchanges NASDAQ, NYSE, AMEX, CBOE. " +
      "Rows carry symbol, companyName, sector, industry, exchange, price, marketCap plus any `fields`, filtered fields and the sort field.",
    shape: {
      sector: z.string().optional().describe("FMP sector name, e.g. Technology, Healthcare."),
      industry: z.string().optional().describe("FMP industry name, e.g. \"Banks - Regional\"."),
      exchange: z.string().optional().describe("Comma list of NASDAQ, NYSE, AMEX, CBOE, OTC."),
      marketCapMin: z.number().optional(),
      marketCapMax: z.number().optional(),
      peMin: z.number().optional().describe("TTM P/E."),
      peMax: z.number().optional(),
      epsGrowthMin: z.number().optional().describe("Latest fiscal-year EPS growth, fraction."),
      revenueGrowthMin: z.number().optional().describe("Latest fiscal-year revenue growth, fraction."),
      dividendYieldMin: z.number().optional().describe("Fraction, 0.02 = 2%."),
      betaMax: z.number().optional(),
      ratingMin: z.number().int().min(1).max(5).optional().describe("FMP overall rating score 1-5."),
      upsideMin: z.number().optional().describe("Percent upside to analyst average target."),
      sort: z.enum(SCREEN_FIELDS).optional().describe("Default marketCap. Nulls sort last."),
      order: z.enum(["asc", "desc"]).optional(),
      limit: z.number().int().min(1).max(500).optional().describe("Default 50."),
      fields: z.array(z.enum(SCREEN_FIELDS)).optional().describe("Extra columns to include."),
    },
    run: (a, cfg) => {
      const { fields, ...rest } = a;
      return apiGet(cfg, "/api/research/screen", { ...rest, fields: fields?.join(",") });
    },
  },
  {
    name: "ideas",
    description:
      "The app's current trade candidates from its scan engine (never orders). kind=stock: top-ranked stocks by multi-factor score (months horizon). " +
      "kind=option: intraday-to-swing setups: long_call (buy call), short_put (sell cash-secured put), covered_call (sell call against owned shares); puts are only ever sold. " +
      "Each idea has symbol, strategy, contract (OCC, options), score 0-100, rank, reasons, firstSeen/lastSeen.",
    shape: {
      kind: z.enum(["stock", "option"]).optional().describe("Default stock."),
      limit: z.number().int().min(1).max(100).optional().describe("Max ideas, best first (default 25)."),
    },
    run: (a, cfg) => apiGet(cfg, "/api/scan/ideas", { kind: a.kind ?? "stock", status: "active", ...pick(a, ["limit"]) }),
  },
  {
    name: "scorecard",
    description:
      "Scan-engine scorecards for one symbol: `stock` (nightly 0-100 composite, per-group scores for valuation/quality/growth/earnings/analysts/momentum, per-factor values and 20-day change), " +
      "`live` (intraday momentum refresh) and `options` (momentum, IV metrics, earnings-before-expiry flag and option setups). Any part may be null when not scored.",
    shape: { symbol },
    run: (a, cfg) => apiGet(cfg, `/api/scan/scorecard/${enc(a.symbol)}`),
  },
  {
    name: "universe",
    description: "The symbols the scan engine scores (watchlists, sectors or whole market, plus holdings), the settings that define them, and scan job status.",
    shape: {},
    async run(_a, cfg) {
      const [universe, symbols, status] = await Promise.all([
        apiGet(cfg, "/api/scan/universe"),
        apiGet(cfg, "/api/scan/universe/symbols"),
        apiGet(cfg, "/api/scan/status"),
      ]);
      return { ...universe, symbols: symbols?.symbols, status };
    },
  },
  {
    name: "option_metrics",
    description:
      "Options-data metrics for one underlying from the 5-minute sweep: ATM IV, 30-day IV, IV rank/percentile, 20-day realised vol, implied move, term slope, put/call volume ratio, " +
      "unusual volume contracts and the streamed ATM call/put quotes with delta.",
    shape: { symbol },
    run: (a, cfg) => apiGet(cfg, `/api/options-data/metrics/${enc(a.symbol)}`),
  },
];

/** Compact JSON, cut at `max` characters with a note on how to get the rest. */
export function render(value: unknown, max: number): string {
  const text = JSON.stringify(value) ?? "null";
  if (text.length <= max) return text;
  const note =
    `\n[truncated: showing ${max} of ${text.length} characters. ` +
    "Narrow the request (smaller limit, from/to, a single year/quarter) or use search_transcripts for a topic inside transcripts.]";
  return text.slice(0, max) + note;
}
