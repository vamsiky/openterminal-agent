// Shapes the routes serve, shared by every provider that fills them.

export type Quote = {
  symbol: string;
  name: string | null;
  price: number | null;
  change: number | null;
  changePercent: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  previousClose: number | null;
  bid: number | null;
  ask: number | null;
  volume: number | null;
  avgVolume: number | null;
  marketCap: number | null;
  pe: number | null;
  eps: number | null;
  dividendYield: number | null; // fraction, 0.004 = 0.4%
  week52High: number | null;
  week52Low: number | null;
  beta: number | null;
  sharesOutstanding: number | null;
  currency: string | null;
  exchange: string | null;
  marketState: string | null;
  time: number | null;
  source: string;
  asOf?: string; // ISO time this server fetched it (set in routes/market.ts)
  /** Extended-hours prices since the last regular close, where the source has them. */
  extended?: ExtendedHours;
};

export type SessionPrice = {
  price: number;
  /** From the last regular close. */
  change: number | null;
  changePercent: number | null;
  /** Time of the latest trade in the session. */
  time: string;
  /** True while the session is on and the price moves with every trade. */
  live: boolean;
};

/** After hours (16:00–20:00 New York), overnight (20:00–04:00) and pre-market (04:00–09:30). */
export type ExtendedHours = { post: SessionPrice | null; overnight: SessionPrice | null; pre: SessionPrice | null };

export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };

/** One stock in the heatmap, screener, sector list and recap. */
export type MarketRow = {
  symbol: string;
  name: string;
  price: number | null;
  changePercent: number | null;
  volume: number | null;
  marketCap: number | null;
  sector: string;
  exchange: string;
};

/** One row of /econ-calendar. */
export type EconEvent = {
  title: string;
  country: string;
  date: string; // ISO
  impact: "Low" | "Medium" | "High" | "Holiday";
  forecast: string | null;
  previous: string | null;
  actual: string | null;
};
