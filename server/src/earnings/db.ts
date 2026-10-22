import Database from "better-sqlite3";
import { join } from "node:path";
import { dataDir } from "../db.js";

// Earnings-event store: past report dates with stock and option price paths,
// the upcoming calendar, live option snapshots, rolled-up stats and agent
// reviews. It has its own file (earnings.db) so the backfill and the
// 30-minute snapshot writes stay off terminal.db's lock.
//
// Dates are text YYYY-MM-DD, timestamps ISO UTC, prices REAL. See
// ./contracts.ts for the shapes these rows map to.

export const earningsDb = new Database(join(dataDir, "earnings.db"));
earningsDb.pragma("journal_mode = WAL");
earningsDb.exec(`
-- One row per (symbol, report date) from FMP's per-symbol history, with the confirmation checks.
CREATE TABLE IF NOT EXISTS events (
  symbol TEXT NOT NULL,
  report_date TEXT NOT NULL,          -- corrected date when reason = 'date_shifted'
  original_date TEXT,                 -- FMP's date before any correction
  time TEXT,                          -- bmo | amc | dmh
  time_source TEXT,                   -- fmp | press_release
  t0 TEXT,
  r TEXT,
  fiscal_period TEXT,
  fiscal_year INTEGER,
  period_ending TEXT,
  eps_actual REAL,
  eps_estimate REAL,
  revenue_actual REAL,
  revenue_estimate REAL,
  confirmed INTEGER NOT NULL DEFAULT 0,
  check_fmp INTEGER NOT NULL DEFAULT 0,
  check_transcript INTEGER NOT NULL DEFAULT 0,
  check_press_release INTEGER NOT NULL DEFAULT 0,
  check_volume INTEGER NOT NULL DEFAULT 0,
  reason TEXT,                        -- ok | unconfirmed | date_shifted | no_bars
  fmp_confirmed_flag INTEGER,         -- FMP's own confirmed flag
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (symbol, report_date)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS events_report_date ON events (report_date);

-- Stock prices at each anchor around an event (StockPath).
CREATE TABLE IF NOT EXISTS stock_paths (
  symbol TEXT NOT NULL,
  report_date TEXT NOT NULL,
  t0_m20 REAL,
  t0_m10 REAL,
  t0_m5 REAL,
  t0_m2 REAL,
  t0_m1 REAL,
  t0_open REAL,
  t0_1000 REAL,
  t0_1545 REAL,
  t0_close REAL,
  r_open REAL,
  r_close REAL,
  r_p5 REAL,
  r_p20 REAL,
  prev_close REAL,
  r_volume_ratio REAL,
  atr14_pct REAL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (symbol, report_date)
) WITHOUT ROWID;

-- Next ~120 days of the FMP calendar with report times, refreshed nightly.
CREATE TABLE IF NOT EXISTS upcoming (
  symbol TEXT NOT NULL,
  report_date TEXT NOT NULL,
  time TEXT,
  time_source TEXT,
  t0 TEXT,
  r TEXT,
  fiscal_period TEXT,
  fiscal_year INTEGER,
  period_ending TEXT,
  eps_estimate REAL,
  revenue_estimate REAL,
  fmp_confirmed_flag INTEGER,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (symbol, report_date)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS upcoming_report_date ON upcoming (report_date);

-- Analyst grade changes and price-target moves for names reporting soon.
CREATE TABLE IF NOT EXISTS analyst_actions (
  symbol TEXT NOT NULL,
  date TEXT NOT NULL,
  firm TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  prior_grade TEXT,
  new_grade TEXT,
  price_target REAL,
  prior_price_target REAL,
  PRIMARY KEY (symbol, date, firm, action)
) WITHOUT ROWID;

-- One option leg tracked from entry to R:close (OptionLegPath); prices are JSON {anchor: price}.
CREATE TABLE IF NOT EXISTS option_paths (
  symbol TEXT NOT NULL,
  report_date TEXT NOT NULL,
  entry TEXT NOT NULL,                -- Anchor
  expiry_kind TEXT NOT NULL,          -- event | swing
  leg TEXT NOT NULL,                  -- atm_call | otm_call | atm_put
  contract TEXT NOT NULL,             -- OCC symbol
  expiry TEXT NOT NULL,
  strike REAL NOT NULL,
  spot_at_entry REAL NOT NULL,
  prices TEXT NOT NULL,
  iv_at_entry REAL,
  price_source TEXT NOT NULL,         -- trade | quote
  volume_at_entry_day REAL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (symbol, report_date, entry, expiry_kind, leg)
);

-- Daily bars of the strike ladder, kept so windows can be recomputed without refetching.
CREATE TABLE IF NOT EXISTS option_ladder_bars (
  occ TEXT NOT NULL,
  day TEXT NOT NULL,
  open REAL,
  high REAL,
  low REAL,
  close REAL,
  volume REAL,
  vwap REAL,
  trades INTEGER,
  PRIMARY KEY (occ, day)
) WITHOUT ROWID;

-- 15-minute bars for the ATM +-1 call and ATM put on T0-1, T0 and R.
CREATE TABLE IF NOT EXISTS option_intraday_bars (
  occ TEXT NOT NULL,
  ts TEXT NOT NULL,                   -- bar start, ISO UTC
  open REAL,
  high REAL,
  low REAL,
  close REAL,
  volume REAL,
  trades INTEGER,
  PRIMARY KEY (occ, ts)
) WITHOUT ROWID;

-- Live REST summaries per name and expiry kind; pruned after they roll up into option_paths.
CREATE TABLE IF NOT EXISTS snapshots (
  symbol TEXT NOT NULL,
  ts TEXT NOT NULL,
  expiry_kind TEXT NOT NULL,
  report_date TEXT,
  expiry TEXT,
  spot REAL,
  call_occ TEXT,
  call_strike REAL,
  call_bid REAL,
  call_ask REAL,
  call_iv REAL,
  call_volume REAL,
  call_oi REAL,
  put_occ TEXT,
  put_strike REAL,
  put_bid REAL,
  put_ask REAL,
  put_iv REAL,
  put_volume REAL,
  put_oi REAL,
  implied_move_pct REAL,
  event_premium REAL,                 -- event-expiry IV over the next expiry's
  PRIMARY KEY (symbol, ts, expiry_kind)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS snapshots_ts ON snapshots (ts);

-- EventStats JSON per scope, horizon and report time; rebuilt nightly.
CREATE TABLE IF NOT EXISTS stats (
  scope_key TEXT NOT NULL,            -- e.g. sym:WDC, pool:tech:mid, cap:mid, all
  horizon TEXT NOT NULL,
  time TEXT NOT NULL,                 -- bmo | amc | dmh | any
  json TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (scope_key, horizon, time)
) WITHOUT ROWID;

-- Earnings agent reviews (EarningsReview); list-valued fields are JSON.
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  horizon TEXT NOT NULL,
  report_date TEXT NOT NULL,
  as_of TEXT NOT NULL,
  status TEXT NOT NULL,
  status_reason TEXT,
  base_score REAL NOT NULL,
  adjusted_score REAL,
  adjustment REAL,
  verdict TEXT,
  news_factors TEXT,
  entry_conditions TEXT,
  exit_plan TEXT,
  risks TEXT,
  summary TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  model TEXT
);
CREATE INDEX IF NOT EXISTS reviews_lookup ON reviews (report_date, horizon, symbol);

-- Resume state for the backfill CLI and nightly job, per task (events | stock | options) and symbol.
CREATE TABLE IF NOT EXISTS backfill_progress (
  task TEXT NOT NULL,
  symbol TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'done',  -- done | error
  detail TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (task, symbol)
) WITHOUT ROWID;
`);
