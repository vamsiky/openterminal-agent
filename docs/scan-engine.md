# Scan engine

The scan engine scores stocks and option contracts on a schedule and keeps a short list of ideas for the Ideas widget. It runs inside the API server, reads the data the app already stores, and writes its results to the local database.

**Ideas are candidates. Nothing places orders.** The engine never calls a trading endpoint. An idea is a note that a setup looked good on a given scan. Read the reasons and check the contract, the price and the news before you act.

Contents: [What it does](#what-it-does) · [Universe](#universe) · [Stock scorecard](#stock-scorecard) · [Options scorecard](#options-scorecard) · [Ideas](#ideas) · [Schedule](#schedule) · [API](#api) · [Settings](#settings)

Related: [positions CSV](positions-csv.md) (what you hold) and [options data](options-data.md) (the live option quotes and metrics the options scorecard uses).

## What it does

| Part | Scores | Refresh |
| --- | --- | --- |
| Stock scorecard | Every US stock with a profile, nightly. The universe, every 15 minutes. | Nightly and 15 minutes |
| Options scorecard | Momentum and three option setups for each underlying in the universe | Every 5 minutes |
| Ideas | Top stocks by composite score, and option setups that score well | Stock ideas at 07:00 and 16:30 ET, option ideas every 5 minutes |

All scans run in the regular session only (09:30–16:00 New York time, trading days). Weekends and market holidays are skipped.

## Universe

The universe is the list of symbols the intraday scans and the options data cover. It is set in the Ideas widget settings or with `PUT /api/scan/universe`.

### Modes

| Mode | Symbols included | Filters |
| --- | --- | --- |
| `watchlists` | Symbols on the watchlists in `watchlistIds`. `null` means every watchlist. | None |
| `sector` | US stocks in the chosen `sectors` (FMP sector names, for example `Technology`). `industries` narrows them. `[]` means all industries. | Price, dollar volume, options |
| `market` | Every US stock with a profile | Price, dollar volume, options |

### Filters

Filters apply to `sector` and `market` only.

| Setting | Default | Meaning |
| --- | --- | --- |
| `minPrice` | 5 | Last price must be at least this many dollars. |
| `minAvgDollarVolume` | 20,000,000 | Price times average volume must be at least this many dollars. |
| `requireOptions` | `true` in `market` mode | Only symbols with listed options. The filter uses an `optionable` flag if the data has one. Otherwise it is skipped. |

Only actively trading, US-listed stocks pass. ETFs, funds and foreign listings are dropped. The same US-only rule applies in every mode.

### Holdings are always in the universe

Every stock you hold and every underlying of an option you hold is added to the universe, in any mode and whatever the filters say. A held name is always scored and always gets options data.

The final universe is the mode's set plus the holdings, sorted and de-duplicated. `GET /api/scan/universe/symbols` returns it.

## Stock scorecard

Each stock gets a composite score from 0 to 100, six group scores, and one score per factor. The horizon is months, not days.

### Percentiles

Each raw factor value is turned into a percentile from 0 to 100 within the stock's FMP sector. The comparison set is every US stock with data for that factor, not only the universe. The percentile is direction-adjusted, so a lower P/E gives a higher score.

### Groups and factors

| Group | Factor | Data source |
| --- | --- | --- |
| valuation | P/E | `bulk_ratios_ttm` |
| | EV/EBITDA (lower is better) | `bulk_key_metrics_ttm` |
| | Price to sales (lower is better) | `bulk_ratios_ttm` |
| | FCF yield | `bulk_key_metrics_ttm` |
| | DCF gap, `(DCF − price) / price` | `bulk_dcf` |
| quality | ROIC | `bulk_key_metrics_ttm` |
| | ROE | `bulk_key_metrics_ttm` |
| | Gross margin | `bulk_ratios_ttm` |
| | Operating margin | `bulk_ratios_ttm` |
| | Net debt to EBITDA (lower is better) | `bulk_key_metrics_ttm` |
| | Current ratio | `bulk_ratios_ttm` |
| growth | Revenue growth | `bulk_income_growth` |
| | EPS growth | `bulk_income_growth` |
| earnings | Last earnings surprise, % | `bulk_earnings_surprises` |
| | EPS estimate revision, 30 days | `estimates/store.ts` history, for the next report |
| | EPS estimate revision, 90 days | `estimates/store.ts` history, for the next report |
| analysts | Buy share of the grades consensus | FMP analyst grades |
| | Price-target upside: last quarter's average target against the price | `bulk_price_targets` |
| | Overall rating score | FMP analyst rating |
| momentum | 12-1 month return (skips the last month) | `daily_bars` |
| | 6-month return | `daily_bars` |
| | Close against the 50-day and 200-day SMA | `daily_bars` |
| | RSI(14) | `daily_bars` |
| | Relative strength against SPY | `daily_bars` |
| | Relative strength against the sector ETF | `daily_bars` |

The sector ETF is set by the FMP sector:

| FMP sector | ETF | FMP sector | ETF |
| --- | --- | --- | --- |
| Technology | XLK | Consumer Defensive | XLP |
| Financial Services | XLF | Industrials | XLI |
| Energy | XLE | Basic Materials | XLB |
| Healthcare | XLV | Utilities | XLU |
| Consumer Cyclical | XLY | Real Estate | XLRE |
| Communication Services | XLC | | |

### Group scores and composite

Each group score combines the percentiles of its factors that have data. The composite combines the group scores with the weights below. When a group has no data, its weight is removed and the other weights are scaled up to sum to 1.

| Group | Weight (`stock-v1`) |
| --- | --- |
| valuation | 0.20 |
| quality | 0.20 |
| growth | 0.15 |
| earnings | 0.15 |
| analysts | 0.10 |
| momentum | 0.20 |

The weights are versioned. Every stored scorecard records its `weightsVersion`, so a later change to the weights does not make old scores look different.

### Coverage

`coverage` is the share of factors that have data, from 0 to 1. The stock ideas screen requires a coverage of at least 0.6.

### Change

Each factor also has a `change`: its score now minus its score 20 trading days ago. It is empty when there is no history that far back.

### Storage

The nightly scorecards are stored once per day in `scorecards`. The latest intraday scorecard for each symbol is stored in `scorecards_live`, which is replaced on every 15-minute scan.

### Intraday refresh every 15 minutes

For universe symbols only, the scan refreshes the momentum group and the composite using:

- the live price from the stream (`liveQuote`),
- today's minute bars,
- three intraday factors: price against VWAP, 15-minute RSI, and relative volume against the 20-day average for the same time of day.

The result is ranked again and written to `scorecards_live`. The nightly scores are not changed.

## Options scorecard

The options scorecard runs every 5 minutes, after the options sweep, for universe symbols. It is built from the [options data](options-data.md) and the stock scorecard.

### Momentum

Four trend scores from −100 to +100, for 5-minute, 15-minute, 1-hour and 1-day bars. Each one uses the EMA(9) against the EMA(21), the slope, RSI, and (intraday only) the price against VWAP.

| Field | Window |
| --- | --- |
| `m5` | 5-minute bars |
| `m15` | 15-minute bars |
| `h1` | 60-minute bars |
| `d1` | Daily bars |

### Setups

The engine checks three setups for each underlying. Every setup gets a score and a list of reasons written in words. The option score is the best setup's score.

The engine sells puts and calls, and buys calls. It never buys puts. A call is sold only against at least 100 shares you hold.

| Strategy | Label | In plain words | Contract |
| --- | --- | --- | --- |
| `long_call` | Buy call | Buy a call when the stock is trending up on the 15-minute and 1-hour charts, the daily trend is not down, volume is high, and options are not expensive. A call that expires after earnings is penalised. | ATM call |
| `short_put` | Sell cash-secured put | Sell a put on a stock you would be willing to own, when options are rich, the daily trend is not strongly down, and the stock scores well. The put must be cash-secured. A put that expires after earnings is flagged. | ATM put |
| `covered_call` | Sell covered call | Sell a call against shares you already hold (at least 100 per contract) when options are rich and the stock is flat or falling on the 15-minute and 1-hour charts. A call that expires after earnings or an ex-dividend date is flagged. | ATM call |

Terms used above:

- **ATM** is the strike nearest the price. The contract is the one the stream holds for that side, in `atmCall` or `atmPut`.
- **Options are not expensive** means IV rank is low, or, when rank is not available, the 30-day IV is no more than 1.2 times the 20-day realised volatility.
- **Options are rich** means IV rank is high, or, when rank is not available, the 30-day IV is above the 20-day realised volatility.
- **Would own it** means the stock scorecard composite is at least 60.

The exact thresholds for "strong", "high", "flat" and "not strongly negative" are set in `server/src/quant/option-score.ts`.

A setup's reasons list the inputs that drove the score. The option scorecard is stored in `option_scorecards`, replaced on each scan. A 5-minute history is kept for 30 days.

## Ideas

Ideas are stored in the `ideas` table with `first_seen`, `last_seen` and a status of `active` or `dropped`. A stock or option that stays on the list keeps its first-seen time.

### Stock ideas

- **When.** The screen runs at 07:00 and 16:30 New York time on trading days. The 07:00 screen runs after the bulk refresh. If the refresh failed, it uses the previous day's data.
- **Who.** The top 25 universe stocks by composite score, with coverage of at least 0.6.
- **Reasons.** The three strongest groups or factors, in words. If the next earnings date is less than 30 days away, the date is added.
- **Between screens.** Each 15-minute scan updates the scores and ranks of active stock ideas.

### Option ideas

- **When.** Every 5 minutes, after the options sweep.
- **Who.** Setups with a score of at least 70, top 20 by score.
- **How they drop.** An option idea is dropped when it is missing from two scans in a row.

### Idea fields

Each idea has `kind` (`stock` or `option`), `symbol`, `strategy` (`buy` for stocks, or `long_call`, `short_put`, `covered_call` for options), `contract` (for options), `score`, `rank`, `reasons`, `firstSeen`, `lastSeen` and `status`. The type is `Idea` in [`server/src/scan/contracts.ts`](../server/src/scan/contracts.ts).

## Schedule

All times are New York time. Every job runs on trading days only. A job never overlaps itself: if a run is still going when the next tick comes, the tick is skipped. Each run is recorded in `scan_runs`.

| Job | When | Notes |
| --- | --- | --- |
| FMP bulk refresh | Before the 07:00 screen | Feeds the stock scorecard. |
| Nightly stock scorecards | After the bulk refresh | Every US stock with a profile. |
| Stock ideas screen | 07:00 and 16:30 | See [Stock ideas](#stock-ideas). |
| Intraday stock scan | Every 15 minutes, 09:30–16:00 | Universe only. |
| Options sweep | Every 5 minutes, 09:30–16:00 | See [options data](options-data.md#the-5-minute-sweep). |
| Options scorecards | After each sweep | Universe only. |
| Option ideas | After each sweep | See [Option ideas](#option-ideas). |
| Options stream | 09:25–16:05 | See [options data](options-data.md#stream-selection). |

A holiday is recognised when there are no SPY minute bars after 09:45. The jobs then skip the day.

## API

All routes are under `/api` and need the `x-api-key` header, the same as the [research API](research-api.md#auth). Errors use the usual 400 for bad input and 401 without the key.

### Universe

`GET /api/scan/universe` returns the current settings and the symbol count.

```json
{ "settings": { "mode": "watchlists", "watchlistIds": null, "sectors": [], "industries": [], "minPrice": 5, "minAvgDollarVolume": 20000000, "requireOptions": false }, "symbolCount": 143 }
```

`PUT /api/scan/universe` takes the same `settings` object (validated with zod) and returns the same shape as the GET.

`GET /api/scan/universe/symbols` returns `{ "symbols": ["AAPL", "MSFT", …] }`, the resolved universe.

`GET /api/scan/sectors` returns the distinct FMP sectors and industries in the bulk profiles, for the settings screen.

### Ideas

`GET /api/scan/ideas?kind=stock|option&status=active&limit=`

```json
{ "asOf": "2026-10-21T20:30:04.118Z", "ideas": [ { "id": 41, "kind": "option", "symbol": "NVDA", "strategy": "short_put", "contract": "NVDA261218P00170000", "score": 74, "rank": 1, "reasons": ["…"], "firstSeen": "…", "lastSeen": "…", "status": "active" } ] }
```

`ideas` is an array of `Idea`.

### Scorecard

`GET /api/scan/scorecard/:symbol`

```json
{ "stock": { "symbol": "…", "composite": 0, "groups": {}, "factors": [], "coverage": 0, "weightsVersion": "stock-v1" }, "live": null, "options": null }
```

- `stock` is the nightly `Scorecard`, or `null` if the symbol has none.
- `live` is the latest intraday `Scorecard`, or `null` when there is none.
- `options` is the `OptionScorecard` (momentum, setups, metrics), or `null`.

The `Scorecard` and `OptionScorecard` types are in [`server/src/scan/contracts.ts`](../server/src/scan/contracts.ts).

### Status

`GET /api/scan/status`

```json
{ "runs": { "stock-scan": { "startedAt": "…", "finishedAt": "…", "symbols": 143, "status": "ok", "error": null, "durationMs": 0 } }, "options": { "connected": true, "subscribed": 812, "msgsPerMin": 0, "lastError": null } }
```

`runs` holds the last run of each job. `options` is the options stream's status (see [options data](options-data.md#endpoints)).

### Positions

`GET /api/positions` returns the current snapshot.

```json
{ "importedAt": "2026-10-21T14:02:11.000Z", "positions": [ { "kind": "stock", "symbol": "AAPL", "quantity": 100, "cost": 182.4, "openedAt": "2025-03-03" } ] }
```

`POST /api/positions/import` takes `{ "csv": "<file text>", "filename": "positions.csv" }`. `filename` is optional.

- On success it returns `{ "imported": 7 }`, the number of rows stored. The new snapshot replaces the old one.
- On failure it returns status 400 with `{ "errors": [ { "line": 3, "message": "…" } ] }`. Nothing is replaced.

The file format is in [positions-csv.md](positions-csv.md).

## Settings

| Variable | Default | Effect |
| --- | --- | --- |
| `SCAN_ENABLED` | `1` | `0` turns off every quant job: the stock and intraday scans, the ideas screens and the option scorecards. The API still serves the stored data. |

The options data flags (`OPTIONS_STREAM`, `OPTIONS_SWEEP_*`, `RISK_FREE_RATE` and the others) are listed in [options-data.md](options-data.md#settings).
