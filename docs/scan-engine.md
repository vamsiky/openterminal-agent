# Scan engine

The scan engine scores stocks and option contracts on a schedule and keeps short lists of ideas for the Ideas widget. It runs inside the API server, reads the data the app already stores, and writes its results to the local database.

**Ideas are candidates. Nothing places orders.** The engine reads market data and writes to the local database. It never calls an order endpoint. An idea is a note that a setup looked good on a given scan. Check the contract, the price and the news before you act on one.

Contents: [What it does](#what-it-does) · [Universe](#universe) · [Stock scorecard](#stock-scorecard) · [Options scorecard](#options-scorecard) · [Ideas](#ideas) · [Schedule](#schedule) · [API](#api) · [Settings](#settings) · [Limitations](#limitations)

Related: [positions CSV](positions-csv.md) (what you hold) and [options data](options-data.md) (the option quotes, IV and metrics the options scorecard uses).

## What it does

| Part | What it scores | When |
| --- | --- | --- |
| Stock scorecard, nightly | Every US stock with a profile | 07:00 and 16:30 ET, weekdays |
| Stock scorecard, intraday | The universe, with live prices | Every 15 minutes in the session |
| Options scorecard | Momentum and three option setups per underlying in the universe | Every 5 minutes in the session |
| Ideas | Top stocks by composite score, and option setups that score well | Stock list after each nightly run, option list every 5 minutes |

The session scans run on trading days only, using the Alpaca trading calendar. That calendar includes market holidays and early closes. See [Schedule](#schedule).

## Universe

The universe is the set of symbols the intraday stock scan and the options data cover. Set it in the Ideas widget settings, or with `PUT /api/scan/universe`.

### Modes

| Mode | Symbols included | Filters |
| --- | --- | --- |
| `watchlists` (the default) | Symbols on the watchlists in `watchlistIds`. `null` means every watchlist. | None |
| `sector` | US stocks in the chosen `sectors` (FMP sector names such as `Technology`). `industries` narrows them further. An empty `industries` list means every industry. With no sectors chosen, the set is empty. | Price, dollar volume |
| `market` | Every US stock that passes the filters | Price, dollar volume |

### Filters

The filters apply to `sector` and `market` only.

| Setting | Default | Meaning |
| --- | --- | --- |
| `minPrice` | 5 | The last price must be at least this many dollars. |
| `minAvgDollarVolume` | 20000000 | Price times average volume must be at least this many dollars. |
| `requireOptions` | `true` | Stored with the settings but not applied yet. See [Limitations](#limitations). |

A stock passes the sector and market filters when all of these hold:

- it is not an ETF or a fund,
- it is actively trading,
- it is on one of the listed exchanges,
- its price and its price times average volume pass the two filters above.

Sector and industry names are matched without regard to case.

### US-listed symbols only

Every symbol in the universe must be a US ticker. Foreign listings, indices, crypto pairs and futures are dropped in every mode. A watchlist or sector symbol must also appear in the exchange listings or the FMP profiles. If neither table has been loaded yet, that check is skipped.

### Holdings are always in the universe

Every stock you hold and every underlying of an option you hold is added to the universe, in any mode and whatever the filters say. A holding is not checked against the listings, so a new listing is not dropped just because the listings are behind. It still must be a valid US ticker.

`GET /api/scan/universe/symbols` returns the final list: the mode's set plus the holdings, sorted.

## Stock scorecard

Each stock gets a composite score from 0 to 100, six group scores, and one score per factor. The horizon is months, not days. The weights version is `stock-v2`.

### Percentiles

Each factor's raw value becomes a percentile from 0 to 100. Higher is always better, so a lower P/E scores higher. A zero or negative P/E, EV/EBITDA or price-to-sales counts as the worst value.

Most factors are ranked within the stock's FMP sector. The comparison set is every US stock with a value for that factor, not only the universe. When the sector has fewer than 5 stocks with a value, the whole US market is used instead.

Two factors are always ranked against the whole market: `rs_spy` and `rs_sector`, which compare stocks across sectors. Percentiles are rank-based. Tied values share their average rank.

### Groups and factors

Within a group, every factor counts the same. A group's score is the mean of its factors that have a score.

| Group | Factor | What it is | Data source |
| --- | --- | --- | --- |
| valuation | `pe` | P/E (lower is better) | Bulk ratios (TTM) |
| | `ev_to_ebitda` | EV/EBITDA (lower is better) | Bulk key metrics (TTM) |
| | `price_to_sales` | Price to sales (lower is better) | Bulk ratios (TTM) |
| | `fcf_yield` | Free cash flow yield | Bulk key metrics (TTM) |
| | `dcf_gap` | `(DCF − price) / price`, only when the DCF is positive | Bulk DCF |
| quality | `roic` | Return on invested capital | Bulk key metrics (TTM) |
| | `roe` | Return on equity | Bulk key metrics (TTM) |
| | `gross_margin` | Gross margin | Bulk ratios (TTM) |
| | `operating_margin` | Operating margin | Bulk ratios (TTM) |
| | `net_debt_to_ebitda` | Net debt to EBITDA (lower is better) | Bulk key metrics (TTM) |
| | `current_ratio` | Current ratio | Bulk ratios (TTM) |
| growth | `growth_revenue` | Revenue growth, latest fiscal year | Bulk income growth |
| | `growth_eps` | EPS growth, latest fiscal year | Bulk income growth |
| earnings | `surprise_pct` | Last EPS surprise, `(actual − estimate) / |estimate|`, when it is at most 200 days old | Bulk earnings surprises |
| | `eps_rev_30d` | Change in the EPS estimate for the next report over 30 days, in percent | Stored estimate history |
| | `eps_rev_90d` | The same over 90 days | Stored estimate history |
| analysts | `buy_share` | Share of ratings that are Strong Buy or Buy | Bulk grades consensus |
| | `pt_upside` | Average price target against the price, `target / price − 1`. The target is last quarter's average when it has any targets, else last year's. | Bulk price targets |
| | `rating_score` | FMP overall rating score | Bulk ratings |
| momentum | `ret_12_1` | Return from 12 months ago to 1 month ago | Daily bars |
| | `ret_6m` | 6-month return | Daily bars |
| | `vs_sma50` | Price against its 50-day average | Daily bars |
| | `vs_sma200` | Price against its 200-day average | Daily bars |
| | `rsi14` | RSI over 14 days | Daily bars |
| | `rs_spy` | 6-month return minus SPY's, ranked market-wide | Daily bars |
| | `rs_sector` | 3-month return minus its sector ETF's, ranked market-wide | Daily bars |

A stock whose latest daily bar is more than 7 days old has no momentum factors.

The sector ETF for each FMP sector:

| FMP sector | ETF | FMP sector | ETF |
| --- | --- | --- | --- |
| Technology | XLK | Consumer Defensive | XLP |
| Financial Services | XLF | Industrials | XLI |
| Energy | XLE | Basic Materials | XLB |
| Healthcare | XLV | Utilities | XLU |
| Consumer Cyclical | XLY | Real Estate | XLRE |
| Communication Services | XLC | | |

### Composite and weights

The composite is the weighted mean of the group scores that have a value. A group with no data drops out, and the remaining weights are scaled to sum to 1.

| Group | Weight (`stock-v2`) |
| --- | --- |
| valuation | 0.20 |
| quality | 0.20 |
| growth | 0.15 |
| earnings | 0.15 |
| analysts | 0.10 |
| momentum | 0.20 |

Every stored scorecard records its `weightsVersion`. Cards from before `stock-v2` carry the label `stock-v1`, and their relative-strength factors measured something different.

### Coverage

`coverage` is the share of the 26 stock factors that have a score, from 0 to 1. The stock ideas screen requires at least 0.6.

### Change

Each factor has a `change`: its score now minus its score in the card from about 28 calendar days earlier (the latest card in the 14 days before that). It is `null` when no such card exists.

### Storage

- `scorecards` holds one card per stock per day, from the nightly run. Factor detail is kept for 45 days. Older cards keep the composite and the group scores.
- `scorecards_live` holds the latest intraday card for each symbol. It is replaced on every intraday scan and carries a `rank`.

### Intraday scan every 15 minutes

For universe symbols that have a nightly card, the intraday scan recomputes the momentum group with the live price. It then adds three intraday factors to the momentum group. Each is scored on a fixed scale, not against peers:

| Factor | What it is | Score |
| --- | --- | --- |
| `price_vs_vwap` | Price against the session VWAP | 50 plus 25 points per 1% above VWAP, from 0 to 100 |
| `rsi_15m` | RSI(14) on 15-minute bars | The RSI itself |
| `rel_volume` | Volume so far today against the 20-day average daily volume, scaled to the share of the day's volume that is normally done by this minute | 50 points, plus or minus 25 for each unit above or below 1 (capped at 3). Plus when the price is at or above the previous close, minus when it is below. |

Relative volume uses the typical share of a day's volume by each minute, taken from SPY's last 20 sessions. The benchmarks SPY and the sector ETFs also use their live prices in this pass. The composite and the ranks are then recomputed.

A symbol without a nightly card is skipped. A symbol whose minute bars are stale gets no intraday factors, but its momentum uses the last price it has. A symbol with no price at all keeps its nightly values.

## Options scorecard

The options scorecard runs every 5 minutes, after the options sweep, for universe symbols. It uses the [options data](options-data.md) and the stock scorecard.

### Momentum

Four trend scores from −100 to +100. Each one compares EMA(9) with EMA(21), and adds the slope and RSI. The intraday windows also add the price against VWAP.

| Field | Bars |
| --- | --- |
| `m5` | 5-minute bars, rolled up from minute bars |
| `m15` | 15-minute bars |
| `h1` | Hourly bars, from the daily hourly cache. Falls back to 60-minute bars rolled up from minute bars. |
| `d1` | Daily bars |

A score needs at least 22 bars.

### Setups

The engine checks three setups for each underlying. Each setup gets a score from 0 to 100, rounded to one decimal, and a list of reasons in words. The option score is the best setup's score. The engine sells puts and calls, and buys calls. It never buys puts. It sells a call only against at least 100 shares you hold.

**Buy call (`long_call`)**

- Required: the average of the 15-minute and hourly trends is at least 40, both are above zero, and the daily trend is not negative.
- Score: a base of 40, plus up to 25 for stronger momentum, plus up to 10 for the daily trend. Up to 15 more for cheap implied volatility, and up to 10 for relative volume. A call loses 25 points when earnings fall before its expiry.
- Contract: the streamed ATM call.

**Sell cash-secured put (`short_put`)**

- Required: the stock's composite is at least 60, its implied volatility is rich, and the daily trend is above −50.
- Score: a base of 40, plus up to 25 for rich volatility, plus up to 20 for the composite above 60, plus up to 10 for the hourly trend. A put loses 15 points when earnings fall before its expiry. An ex-dividend date before expiry adds a note and costs 3 points.
- The reasons state the cash needed for 100 shares at the strike.
- Contract: the streamed ATM put.

**Sell covered call (`covered_call`)**

- Required: you hold at least 100 shares, implied volatility is rich, and both the 15-minute and hourly trends are at or below 20.
- Score: a base of 40, plus up to 30 for rich volatility, plus up to 20 for flat or falling momentum, plus 10 when the daily trend is at or below 20. A call loses 10 points when earnings fall before its expiry. An ex-dividend date before expiry loses 30 points and adds a warning about early assignment.
- Contract: the streamed ATM call.

Definitions used above:

- **ATM** is the streamed at-the-money contract: the strike nearest the price, on the nearest usable expiry.
- **Rich implied volatility** means the IV rank is 60 or more. When the IV rank is not available, it means the 30-day IV is above the 20-day realised volatility (`iv30 / hv20 > 1.0`).
- **Cheap implied volatility** means the IV rank is 30 or less. Between 30 and 60 it earns part of the points. Without a rank, it means the 30-day IV is at most 1.2 times the 20-day realised volatility.
- **Strong momentum** starts at 40. **Flat** means 20 or less.
- **Relative volume** is compared with the normal level for the time of day. It is high from 1.5 times.
- **Earnings before expiry** comes from the earnings calendar the app already keeps.

The score and reasons are stored in `option_scorecards`, which is replaced on each scan. A history of each scan is kept for 30 days in `option_scorecards_history`.

## Ideas

Ideas are stored in the `ideas` table. Each idea has a `status` of `active` or `dropped`. Dropped ideas stay in the table. When an idea becomes active again after being dropped, its `firstSeen` is reset.

### Stock ideas

- **When.** The screen runs right after each nightly run, at 07:00 and 16:30 New York time on weekdays. A fresh install runs it once at startup.
- **Who.** The 25 highest composites in the universe, among stocks with a coverage of at least 0.6.
- **Drop rule.** An active stock idea that is not in the top 25 at a screen is marked dropped.
- **Between screens.** Each intraday scan refreshes the score, the reasons and the rank of every active stock idea from its live card.
- **Reasons.** The three strongest groups, each with its score and its best factor against sector peers. When the next earnings date is less than 30 days away, the date is added.

### Option ideas

- **When.** After each option sweep, every 5 minutes in the session.
- **Who.** The best setups in the sweep, top 20 by score, with at most one idea per underlying and strategy.
- **Threshold.** A score of 70 or more. While an underlying has fewer than 20 days of IV history, the threshold is 60, and the reason *IV history < 20 days: IV judged against 20-day realised volatility* is added.
- **Drop rule.** An option idea that is missing from two scans in a row is marked dropped.

### Idea fields

| Field | Meaning |
| --- | --- |
| `id` | Row id |
| `kind` | `stock` or `option` |
| `symbol` | Ticker |
| `strategy` | `buy` for stocks. For options, `long_call`, `short_put` or `covered_call`. |
| `contract` | OCC symbol for options, `null` for stocks |
| `score` | Score at the last scan |
| `rank` | Position in the list, from 1 |
| `reasons` | List of short sentences |
| `firstSeen`, `lastSeen` | ISO times |
| `status` | `active` or `dropped` |

The type is `Idea` in [`server/src/scan/contracts.ts`](../server/src/scan/contracts.ts).

## Schedule

All times are New York time. Jobs run on trading days only, using the Alpaca trading calendar, so holidays are skipped and early closes end early.

| Job | When | Notes |
| --- | --- | --- |
| Dividend calendar | Once a day, when the server is running | Upcoming ex-dividend dates for the next 60 days, from FMP. |
| Hourly bars | 07:30, once a day | Hourly bars for the universe. A failure is retried after an hour. |
| Nightly stock scorecards | 07:00 and 16:30 | Every US stock with a profile. Runs on weekdays. |
| Stock ideas screen | Right after each nightly run | |
| Intraday stock scan | 09:45, 10:00, … up to 15:45 | Every 15 minutes, starting 15 minutes after the open. Each run starts about 20 seconds into its slot. |
| Options sweep | 09:30, then every 5 minutes to the close | See [options data](options-data.md#the-5-minute-sweep). |
| Options scorecard and option ideas | About 90 seconds after each slot, from 09:35 to 15:55 | Starts after the sweep's slot has had time to run. |
| Options stream | 09:25 to 16:05 | See [options data](options-data.md#stream-selection). |

Jobs never overlap. Each run is recorded in `scan_runs`. If a run is still going when its next slot comes, that slot is late rather than doubled. A run left open by a stopped process is marked as an error at the next start.

## API

Every route is under `/api/scan` (or `/api/positions`) and needs the `x-api-key` header, as in the [research API](research-api.md#auth). Errors use 400 for bad input and 401 when the key is missing.

### Universe

`GET /api/scan/universe`

```json
{
  "settings": {
    "mode": "watchlists",
    "watchlistIds": null,
    "sectors": [],
    "industries": [],
    "minPrice": 5,
    "minAvgDollarVolume": 20000000,
    "requireOptions": true
  },
  "symbolCount": 143
}
```

`PUT /api/scan/universe` and `POST /api/scan/universe` both save the settings. The web app uses POST, because its proxy forwards only GET, POST and DELETE. The body is the `settings` object above. The response has the same shape as the GET. A body that fails validation returns 400 with `{ "error": "path: message; …" }`.

`GET /api/scan/universe/symbols` returns the resolved list.

```json
{ "symbols": ["AAPL", "BRK.B", "MSFT", "NVDA"] }
```

`GET /api/scan/sectors` returns the sectors and industries in the bulk profiles, for the settings screen.

```json
{
  "sectors": ["Technology", "Healthcare"],
  "industries": [{ "sector": "Technology", "industry": "Software - Infrastructure" }]
}
```

### Ideas

`GET /api/scan/ideas?kind=stock|option&status=active|dropped&limit=`

- `kind` is optional. `status` defaults to `active`. `limit` defaults to 25 and can be 1 to 100.
- `asOf` is the time of the latest scan of that kind, or `null` when none has run.

```json
{
  "asOf": "2026-10-21T20:30:04.118Z",
  "ideas": [
    {
      "id": 41,
      "kind": "option",
      "symbol": "NVDA",
      "strategy": "short_put",
      "contract": "NVDA261218P00170000",
      "score": 74,
      "rank": 1,
      "reasons": [
        "stock score 72/100: worth owning if assigned",
        "IV rank 68/100: premium is rich",
        "daily trend 12/100, not falling hard"
      ],
      "firstSeen": "2026-10-21T14:05:00.000Z",
      "lastSeen": "2026-10-21T20:30:04.118Z",
      "status": "active"
    }
  ]
}
```

The values are illustrative. The shapes follow the `Idea` type.

### Scorecard

`GET /api/scan/scorecard/:symbol` returns the symbol's latest cards. It returns 400 for an invalid symbol.

```json
{
  "stock": {
    "symbol": "MSFT",
    "asOf": "2026-10-21T20:30:00.000Z",
    "sector": "Technology",
    "industry": "Software - Infrastructure",
    "composite": 68.4,
    "groups": { "valuation": 41.2, "quality": 82.0, "growth": 70.5, "earnings": 66.0, "analysts": 74.1, "momentum": 61.3 },
    "factors": [
      { "key": "roic", "group": "quality", "value": 0.31, "score": 88, "change": 2.5 },
      { "key": "pe", "group": "valuation", "value": 34.2, "score": 35, "change": null }
    ],
    "coverage": 0.96,
    "weightsVersion": "stock-v2"
  },
  "live": {
    "symbol": "MSFT",
    "asOf": "2026-10-21T15:15:00.000Z",
    "composite": 69.1,
    "groups": {},
    "factors": [],
    "coverage": 0.96,
    "weightsVersion": "stock-v2",
    "rank": 12
  },
  "options": {
    "underlying": "MSFT",
    "asOf": "2026-10-21T15:35:00.000Z",
    "score": 58.5,
    "momentum": { "m5": 12, "m15": 25, "h1": 31, "d1": 18 },
    "metrics": null,
    "earningsBeforeExpiry": false,
    "nextEarnings": "2026-10-28",
    "setups": [
      { "strategy": "long_call", "score": 58.5, "contract": "MSFT261120C00430000", "reasons": ["…"] }
    ]
  }
}
```

- `stock` is the latest nightly `Scorecard`, or `null`.
- `live` is the latest intraday `Scorecard` with its `rank`, or `null`.
- `options` is the latest `OptionScorecard`, or `null`. Its `metrics` is the underlying's `OptionMetrics` (see [options data](options-data.md#metrics)).

The values are illustrative. The `groups` and `factors` lists are shortened.

### Scan status and forced runs

`GET /api/scan/status`

```json
{
  "runs": {
    "stock-nightly": { "started_at": "2026-10-21T20:30:00.000Z", "finished_at": "2026-10-21T20:31:12.000Z", "status": "ok", "symbols": 6021, "duration_ms": 72000, "error": null },
    "option-scan": { "started_at": "2026-10-21T19:55:00.000Z", "finished_at": "2026-10-21T19:55:04.000Z", "status": "ok", "symbols": 143, "duration_ms": 4000, "error": null }
  },
  "options": {
    "enabled": true,
    "connected": true,
    "subscribed": 812,
    "targets": 812,
    "msgsPerMin": 4300,
    "lastMessageAt": "2026-10-21T19:59:58.000Z",
    "lastError": null,
    "feed": "opra",
    "refused": false,
    "sweepEnabled": true,
    "backfill": { "running": false, "total": 143, "done": 143, "errors": 0 },
    "rejectedSymbols": [],
    "sweeping": false,
    "lastSweep": { "startedAt": "2026-10-21T19:55:00.000Z", "finishedAt": "2026-10-21T19:55:04.000Z", "underlyings": 143, "requests": 61, "durationMs": 4000, "errors": 0, "lastError": null }
  }
}
```

- `runs` has the latest run of each job: `stock-nightly`, `ideas-screen`, `stock-intraday`, `option-scan` and `hourly-bars`. Fields are as in `scan_runs`. A job that has never run is missing.
- `options` is the options status described in [options data](options-data.md#endpoints), or `null` when the options layer is not running.

`POST /api/scan/run/:job` runs a job now. `:job` is one of `stock-nightly`, `ideas-screen`, `stock-intraday` or `option-scan`; any other name returns 404. It returns `{ "ran": "option-scan", "run": { … } }`. It returns 409 when another run is in progress, and 409 for `option-scan` when the options layer is not connected.

### Positions

`GET /api/positions` returns the current snapshot.

```json
{
  "importedAt": "2026-10-21T14:02:11.000Z",
  "positions": [
    { "kind": "stock", "symbol": "AAPL", "quantity": 100, "cost": 182.4, "openedAt": "2025-03-03" },
    { "kind": "option", "occ": "NVDA261120P00170000", "underlying": "NVDA", "expiry": "2026-11-20", "strike": 170, "right": "put", "quantity": -1, "cost": 3.1, "openedAt": "2026-09-28" }
  ]
}
```

`POST /api/positions/import` takes `{ "csv": "<the file text>", "filename": "positions.csv" }`. `filename` is optional, and the CSV may be up to 1,000,000 characters.

- On success it returns `200` with `{ "imported": 2 }`, the number of positions stored. The new snapshot replaces the old one in one transaction.
- On failure it returns `400` with `{ "errors": [ { "line": 3, "message": "…" } ] }`. Nothing is replaced.

The file format is in [positions-csv.md](positions-csv.md).

## Settings

| Variable | Default | Effect |
| --- | --- | --- |
| `SCAN_ENABLED` | `1` | `0` turns off the quant jobs: the nightly and intraday stock scorecards, the ideas screens, the hourly bars and the options scorecard. The options sweep and stream are separate and keep running. Set `OPTIONS_SWEEP=0` and `OPTIONS_STREAM=0` to stop them too. |

The options data settings (`OPTIONS_STREAM`, `OPTIONS_SWEEP`, `OPTIONS_BACKFILL`, `ALPACA_OPTIONS_FEED`, the `OPTIONS_STREAM_*` and `OPTIONS_SWEEP_*` limits, `RISK_FREE_RATE` and `OPTION_BARS_RETENTION_DAYS`) are listed in [options-data.md](options-data.md#settings).

## Limitations

- **`requireOptions` is not applied.** The setting is stored, and the sector and market modes do not yet filter out symbols without listed options. The sweep skips any underlying that has no option chain, so those symbols cost nothing but a request.
- **IV backfill and stock splits.** The IV backfill reads stored daily closes and Alpaca's historical option bars. It has no check for stock splits, so IV values on days near a split can be wrong. See [options data](options-data.md#iv-backfill).
- **Unusual volume needs open interest.** Open interest comes once a day from Alpaca's contract data. A contract without open interest is never flagged as unusual.
- **Stream volume counts trades since subscribe.** The streamed `tradedSize` counts only the trades seen since this process subscribed to the contract. It is not the day's volume. The sweep's volume figures use the day's volume from the snapshots.
