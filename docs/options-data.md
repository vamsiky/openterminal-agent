# Options data

The options data layer keeps live option quotes, implied volatility and per-underlying metrics for the scan engine. It has four parts:

- a **live stream** of quotes for a small set of contracts,
- a **5-minute sweep** over the option chains of the universe, which computes the metrics,
- an **open-interest** fetch, once a day,
- a **store** that keeps minute bars, daily implied volatility, open interest and the latest metrics.

Everything uses the Alpaca options data API with the same keys as the rest of the market data. Open interest also reads Alpaca's trading API for contract data. Nothing places orders.

Contents: [Stream selection](#stream-selection) · [The 5-minute sweep](#the-5-minute-sweep) · [Metrics](#metrics) · [IV rank and percentile](#iv-rank-and-percentile) · [IV backfill](#iv-backfill) · [Storage and retention](#storage-and-retention) · [Endpoints](#endpoints) · [Settings](#settings)

Related: [scan engine](scan-engine.md) (the scorecards and ideas that use these metrics).

## Stream selection

Streaming every option is not possible. The OPRA feed takes at most 1,000 quote subscriptions (`OPTIONS_STREAM_MAX`), so the stream follows a fixed selection rule. The selection is rebuilt after every sweep.

Alpaca can answer a subscribe with 405 "symbol limit exceeded" and then rejects the whole message, leaving earlier subscriptions unchanged. The stream treats Alpaca's `subscription` reply as the truth for what is streamed, and on a 405 keeps the confirmed contracts, logs `[options] Alpaca symbol limit: streaming N of M contracts`, and caps later selections at N (the first N, so held options and top-ranked underlyings stay). It does not reconnect; the next connection tries the full list once. `/api/scan/status` reports `options.subscribed` (confirmed), `targets`, `limited` (N, or null) and `inWindow` (whether the stream should be connected now). The Ideas status line shows "option stream closed (market hours only)" outside the window and "N of M contracts streamed (Alpaca limit)" when limited.

**Priority order of underlyings:**

1. The underlyings of your holdings, stocks and options alike.
2. The rest of the universe, by the latest option score, highest first.
3. Then by the latest stock composite, highest first.
4. Then alphabetically.

**The selected set, in order:**

1. **Every held option.** Each held contract is added first. Only if the held options alone exceed the cap are the extra ones left out. A warning is logged when that happens.
2. **Per underlying, one call and one put at the same strike.** The strike is the one nearest the price. The expiry is the nearest one at least `OPTIONS_STREAM_MIN_DTE` days away (default 7), with strikes inside the sweep's window. An underlying's pair is added whole or not at all. When a pair does not fit under the cap, the underlying is skipped and later underlyings can still fit.

### Re-centering

As the price moves, the nearest strike changes. The stream moves to the new strike only when that strike is clearly nearer. The rule is a hysteresis band:

> Keep the current strike unless another strike is nearer to the price by more than 25% of the strike gap next to the price.

The current strike is kept only while its expiry is still the front expiry. If the expiry changes, the nearest strike is taken.

Example. Strikes are 5 dollars apart. The stream holds the 100 strike. The price moves to 103.50.

- Distance to 100 is 3.50. Distance to 105 is 1.50. The new strike is 2.00 nearer.
- 25% of the gap is 1.25. Because 2.00 is more than 1.25, the stream re-centres on 105.

If the price had moved to 102.60, the difference would be 0.20. That is less than 1.25, so the stream would stay on 100. This stops the stream from churning when the price hovers between two strikes.

### Subscriptions

After each sweep the stream compares the new set with the subscribed set. It subscribes to the contracts that were added and unsubscribes from those that left. It does not reconnect for a change. Subscribe requests go out in batches of 200.

The stream is open only in the window from 09:25 to 16:05 New York time, on trading days. The window follows the Alpaca trading calendar, so holidays and early closes are handled.

### Connection

- Endpoint: `wss://stream.data.alpaca.markets/v1beta1/opra`, with the feed set by `ALPACA_OPTIONS_FEED` (default `opra`).
- Messages are MessagePack. The client authenticates with the same key and secret as the stock stream.
- On disconnect it reconnects with backoff, but only while the stream window is open.
- If Alpaca refuses the stream (error codes 402, 409 or 412), the stream does not reconnect and logs a warning. The status field `refused` is then `true`.
- `OPTIONS_STREAM=0` turns the stream off. The sweep and the metrics still run.

For each contract the stream keeps the latest quote and trade in memory. It computes implied volatility and delta from each quote, at most once a second per contract. Quotes are written to minute bars every 5 seconds.

## The 5-minute sweep

The sweep runs at the session open and then every 5 minutes until the close, on trading days. It checks the clock every 15 seconds. A sweep that runs past its slot delays the next one. Sweeps never overlap.

For each underlying in the universe, the sweep:

1. reads the stock price from the snapshot, unless the underlying was rejected by Alpaca today,
2. requests the option snapshots for expiries from today to `OPTIONS_SWEEP_MAX_DTE` days ahead (default 60), with strikes within `OPTIONS_SWEEP_STRIKE_RANGE` of the price on each side (default 0.15, which is 15%),
3. computes the implied volatility of each contract from its quote mid, with Alpaca's implied volatility as the fallback, and the delta from the same model,
4. computes the metrics described below and saves them as the underlying's latest `OptionMetrics`,
5. updates the stream selection with the sweep's prices and expiries.

Requests run with a concurrency limit (`OPTIONS_SWEEP_CONCURRENCY`, default 4).

Open interest is fetched once per trading day for each underlying, on the first sweep of that day, and cached. Alpaca rejects some symbols. A rejected symbol is skipped by the sweep and by the open-interest fetch for the rest of the day, and listed in `rejectedSymbols`.

Each sweep also writes the day's IV row. See [Storage](#storage-and-retention).

## Metrics

Each underlying has one `OptionMetrics` record, saved by every sweep. The type is defined in [`server/src/scan/contracts.ts`](../server/src/scan/contracts.ts).

| Field | Meaning |
| --- | --- |
| `underlying` | The stock ticker. |
| `asOf` | When the sweep produced the record (ISO time). |
| `price` | The underlying price the sweep used. `null` when there was none. |
| `atmExpiry` | Expiry of the streamed pair (the call and put). |
| `atmCall` | OCC symbol of the streamed ATM call. |
| `atmPut` | OCC symbol of the streamed ATM put. |
| `atmIv` | ATM implied volatility at `atmExpiry`, annualised. `0.35` means 35%. |
| `iv30` | Constant-maturity 30-day ATM implied volatility. See below. |
| `ivRank` | Where `iv30` sits in its own range over the last up to 252 trading days, 0 to 100. `null` under 20 days of history. See [IV rank and percentile](#iv-rank-and-percentile). |
| `ivPercentile` | Share of the same window on which `iv30` was below today's value, 0 to 100. Same window and same `null` rule as `ivRank`. |
| `ivHistoryDays` | How many days the rank is based on, including today. |
| `hv20` | 20-day realised volatility, annualised. |
| `impliedMovePct` | Price move the options imply, in percent: the ATM call mid plus the ATM put mid, divided by the price, times 100, at `atmExpiry`. |
| `termSlope` | ATM IV at the expiry nearest 60 days, minus `atmIv`, in volatility points (the IV difference times 100). |
| `putCallVolumeRatio` | Total put volume divided by total call volume over the contracts the sweep requests. |
| `unusual` | Contracts with unusually heavy volume. See [Unusual activity](#unusual-activity). |
| `atmCallQuote` | Bid, ask and delta of the streamed ATM call. `null` when there is no contract. |
| `atmPutQuote` | Bid, ask and delta of the streamed ATM put. `null` when there is no contract. |

### How the IV figures are built

- **ATM IV for one expiry.** Each strike's call and put IVs are averaged. The value is then interpolated between the two strikes that bracket the price.
- **`iv30`.** The ATM IV of each expiry at least 3 days out is found. Those values are interpolated to 30 days on total variance (IV squared times time). When only one side of 30 days exists, that expiry's IV is used.
- **Implied volatility of a contract.** Solved from the quote mid with Black-Scholes, by Newton's method with bisection as the fallback. It is `null` when the mid is below intrinsic value or when there is no bid.
- **Black-Scholes model.** European, with the risk-free rate from `RISK_FREE_RATE` (default 0.04). The live model uses no dividend yield. Time to expiry runs to the regular close on the expiry day.
- **Greeks.** Delta, gamma, theta and vega. Theta is per calendar day. Vega is per volatility point.
- **`hv20`.** Sample standard deviation of the last 20 daily log returns, times the square root of 252.

### Quotes

`atmCallQuote` and `atmPutQuote` use the stream's bid, ask and delta when the stream's quote is less than 2 minutes old. Otherwise they use the sweep's snapshot. The snapshot delta comes from the model at the contract's IV, or from Alpaca's greeks when the model cannot give one.

### Unusual activity

A contract is listed in `unusual` when all of these hold:

- it expires in at least 2 days,
- its volume is at least 500,
- its open interest is at least 100,
- its volume is at least 2 times its open interest.

The list is sorted by `volume / openInterest`, highest first, and cut to 10. Each entry has `occ`, `volume`, `openInterest` and `ratio`, where `ratio` is volume divided by open interest.

A contract without open interest is never listed. Open interest comes from Alpaca's contract data, once a day. See [Limitations](scan-engine.md#limitations).

## IV rank and percentile

`ivRank` and `ivPercentile` compare today's `iv30` with the stored history of `iv30` for the same underlying.

- **Window.** The last 252 rows of `iv_history`, including today's.
- **Rank.** `(today − lowest) / (highest − lowest) × 100`. It is 50 when the window is flat.
- **Percentile.** The share of rows in the window with an `iv30` strictly below today's.
- **Minimum.** Both are `null` until the window has at least 20 rows, including today. `ivHistoryDays` shows how many rows are used.

**Caveat: history takes time to build.** Rank needs about 20 trading days of stored history. An underlying with no backfill and no live history has `null` rank and percentile. [IV backfill](#iv-backfill) fills a year of history for the universe at startup. Until it has run, or for a new listing, rank stays `null`. A `null` rank is normal in that case, not an error. The scan engine then judges IV against the 20-day realised volatility instead.

## IV backfill

The backfill fills `iv_history` with a year of daily IV from Alpaca's historical option bars, so IV rank works from the first day.

For each of the last 252 trading days of an underlying:

- it picks the two monthly expiries that bracket 30 days out: the latest between 3 and 30 days, and the first at 30 days or more. Monthly expiries are the third Friday, or the trading day before it when that Friday is a holiday.
- it tries candidate strikes on the usual strike grid for the price level, around the day's close. For each contract with a bar on that day, it takes the bar nearest the close. Alpaca does not list the strikes that existed then, so the grid is what makes a contract findable.
- it turns each contract's daily close into an IV with Black-Scholes, averages the call and put per expiry, and interpolates to 30 days the way the live `iv30` is built.
- `hv20` comes from the stored daily closes. `atmIv` is left empty for backfilled rows.

Backfilled rows have `source = 'backfill'`. A live row always replaces a row, and a backfill never overwrites a live row.

**When it runs:**

- At startup, for universe underlyings with fewer than 200 rows in `iv_history`. It runs in the background and pauses while a sweep is running. Set `OPTIONS_BACKFILL=0` to turn this off.
- On demand, with `POST /api/options-data/backfill-iv`.
- From the command line: `npm run backfill-iv -w server` fills the watchlist symbols with fewer than 200 rows. `npm run backfill-iv -w server -- --symbols SPY,AAPL` fills the named symbols regardless of their row count. It is safe to run again.

## Storage and retention

| Data | Table | Kept | Written |
| --- | --- | --- | --- |
| Minute bars of each option contract: bid, ask, mid, last, volume, IV, delta | `option_minute_bars`, in the minute-bar database (`data/minute_bars.db`) | `OPTION_BARS_RETENTION_DAYS` days (default 90). Older rows are pruned every 6 hours. | Every few seconds from the stream |
| Daily IV: `iv30`, ATM IV, `hv20` and `source` (`live` or `backfill`), per underlying per day | `iv_history` | Not pruned | Each sweep between 15:55 and 16:10 New York time records the day's row, and later sweeps that day update it. Backfill fills older days. |
| Latest `OptionMetrics` per underlying | `option_metrics` | Latest only | Each sweep |
| Open interest per contract, per day | `option_open_interest` | Kept | Once a day per underlying |
| Symbols Alpaca rejected, per day | `option_rejected_symbols` | Kept | When rejected |

Minute bars are the only data that grows quickly. At the default retention, about three months of option minute bars are kept.

## Endpoints

All routes are under `/api/options-data` and need the `x-api-key` header.

### `GET /api/options-data/stream`

Stream status and the contracts it is subscribed to, each with its latest quote.

```json
{
  "status": {
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
    "sweeping": false,
    "rejectedSymbols": [],
    "backfill": { "running": false, "startedAt": null, "finishedAt": "2026-10-21T13:10:00.000Z", "total": 143, "done": 143, "current": null, "rows": 36000, "requests": 1400, "errors": 0 },
    "lastSweep": { "startedAt": "2026-10-21T19:55:00.000Z", "finishedAt": "2026-10-21T19:55:04.000Z", "underlyings": 143, "requests": 61, "durationMs": 4000, "errors": 0, "lastError": null }
  },
  "contracts": [
    {
      "occ": "NVDA261120P00170000",
      "quote": { "occ": "NVDA261120P00170000", "bid": 2.95, "ask": 3.1, "bidSize": 10, "askSize": 12, "quoteAt": 1789940398000, "last": 3.05, "lastAt": 1789940380000, "tradedSize": 46, "iv": 0.48, "delta": -0.42, "ivAt": 1789940398000 }
    }
  ]
}
```

- `status` is `null` before the options layer starts, and `contracts` is then empty.
- `status.connected`, `subscribed`, `msgsPerMin` and `lastError` describe the stream. `lastError` falls back to the last sweep's error when the stream has none.
- `status.backfill` is the backfill status. `errors` is a count here.
- `status.rejectedSymbols` lists the underlyings Alpaca rejected today.
- `status.lastSweep` describes the latest sweep. `null` before the first one.
- `quote.tradedSize` counts trades since this process subscribed to the contract. See [Limitations](scan-engine.md#limitations).

The values are illustrative. The shape follows the stream status and the `ContractQuote` type.

### `GET /api/options-data/metrics/:symbol`

The latest `OptionMetrics` for one underlying, as described in [Metrics](#metrics). It returns 404 when there is no record for the symbol.

```json
{
  "underlying": "AAPL",
  "asOf": "2026-10-21T15:30:02.000Z",
  "price": 214.35,
  "atmExpiry": "2026-11-20",
  "atmCall": "AAPL261120C00215000",
  "atmPut": "AAPL261120P00215000",
  "atmIv": 0.27,
  "iv30": 0.28,
  "ivRank": null,
  "ivPercentile": null,
  "ivHistoryDays": 6,
  "hv20": 0.22,
  "impliedMovePct": 4.1,
  "termSlope": 1.2,
  "putCallVolumeRatio": 0.84,
  "unusual": [],
  "atmCallQuote": { "bid": 3.40, "ask": 3.55, "delta": 0.51 },
  "atmPutQuote": { "bid": 3.20, "ask": 3.35, "delta": -0.49 }
}
```

The values are illustrative. Here `ivRank` and `ivPercentile` are `null` because there are only 6 days of history.

### `GET /api/options-data/iv/:symbol?days=`

The stored daily IV rows for one underlying, newest first. `days` defaults to 252 and must be a whole number from 1 to 5000.

```json
{
  "symbol": "AAPL",
  "history": [
    { "symbol": "AAPL", "day": "2026-10-21", "iv30": 0.28, "atmIv": 0.27, "hv20": 0.22, "source": "live" },
    { "symbol": "AAPL", "day": "2026-10-20", "iv30": 0.29, "atmIv": 0.28, "hv20": 0.23, "source": "backfill" }
  ]
}
```

### `GET /api/options-data/bars/:occ?from=&to=`

Stored minute bars for one contract. `from` and `to` are unix seconds or ISO times. They default to the last 24 hours.

```json
{
  "occ": "AAPL261120C00215000",
  "bars": [
    { "occ": "AAPL261120C00215000", "ts": 1789940340, "bid": 3.40, "ask": 3.55, "mid": 3.475, "last": 3.50, "volume": 120, "iv": 0.27, "delta": 0.51 }
  ]
}
```

The values are illustrative. Field names follow the stored bar.

### `POST /api/options-data/backfill-iv`

Starts an IV backfill in the background. The body is optional:

```json
{ "symbols": ["SPY", "AAPL"] }
```

Without `symbols`, it backfills the universe underlyings with fewer than 200 rows. It returns:

- `202` with `{ "started": true, "backfill": { … } }` when it starts,
- `409` with `{ "error": "a backfill is already running", "backfill": { … } }` when one is running,
- `503` when the options layer is not running.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPTIONS_STREAM` | `1` | `0` turns off the live stream. The sweep and metrics keep running. |
| `OPTIONS_SWEEP` | `1` | `0` turns off the 5-minute sweep. The stream then has no targets. |
| `OPTIONS_BACKFILL` | `1` | `0` turns off the IV backfill at startup. The routes and the command still work. |
| `ALPACA_OPTIONS_FEED` | `opra` | Alpaca options feed for the stream. |
| `ALPACA_TRADING_BASE` | auto | Base URL of Alpaca's trading API, used for the market calendar and open interest. Auto-detected: the live host is tried first, and the paper host is used when the live one answers 401 or 403. Set it to pin one. |
| `OPTIONS_STREAM_MAX` | `1000` | Most contracts the stream subscribes to. |
| `OPTIONS_STREAM_MIN_DTE` | `7` | Shortest expiry, in days, used for the streamed pair. |
| `OPTIONS_SWEEP_MAX_DTE` | `60` | Longest expiry, in days, the sweep requests. |
| `OPTIONS_SWEEP_STRIKE_RANGE` | `0.15` | Strikes the sweep requests, as a fraction of the price on each side. |
| `OPTIONS_SWEEP_CONCURRENCY` | `4` | Requests the sweep runs at once. |
| `RISK_FREE_RATE` | `0.04` | Risk-free rate for the option model, annual. |
| `OPTION_BARS_RETENTION_DAYS` | `90` | Days of option minute bars to keep. |

`SCAN_ENABLED=0` turns off the quant jobs (the scorecards and ideas), not the sweep or the stream. See [scan engine: settings](scan-engine.md#settings).
