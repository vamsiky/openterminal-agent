# Options data

The options data layer keeps live option quotes, implied volatility and per-underlying metrics for the scan engine. It has three parts:

- a **live stream** of quotes for a small set of contracts,
- a **5-minute sweep** over the option chains of the universe, which computes the metrics,
- a **store** that keeps minute bars, daily implied volatility and the latest metrics.

Everything here uses the Alpaca OPRA feed, with the same keys as the rest of the market data. The layer never places orders.

Contents: [Stream selection](#stream-selection) · [The 5-minute sweep](#the-5-minute-sweep) · [Metrics](#metrics) · [IV rank and percentile](#iv-rank-and-percentile) · [Storage and retention](#storage-and-retention) · [Endpoints](#endpoints) · [Settings](#settings)

Related: [scan engine](scan-engine.md) (the scorecards and ideas that use these metrics).

## Stream selection

Streaming every option is not possible. Alpaca's OPRA feed allows 1,000 quote subscriptions on one connection, so the stream follows a fixed selection rule.

The selection is a set of contracts. It is rebuilt from these inputs:

- the **held** options from your [positions](positions-csv.md), and the underlyings of the stocks and options you hold,
- the **universe** (see [scan engine: universe](scan-engine.md#universe)), in its order,
- the latest price of each underlying.

The rules, in order:

1. **Every held option is in the set.** Held contracts are never dropped.
2. **Per underlying, one call and one put** at the strike nearest the current price, on the nearest expiry at least `OPTIONS_STREAM_MIN_DTE` days away (default 7).
3. **Priority.** Holdings come first, then the universe in order. When the set is over `OPTIONS_STREAM_MAX` (default 1,000), the lowest-priority underlyings are dropped. Holdings are never dropped.

### Re-centering

As the price moves, the nearest strike changes. The stream moves to the new strike only when it is clearly nearer. The rule is a hysteresis band:

> Re-centre only when another strike is nearer to the price by more than 25% of the strike gap.

Example. Strikes are 5 dollars apart. The stream holds the 100 call. The price moves to 103.50.

- Distance to 100: 3.50. Distance to 105: 1.50. The new strike is 2.00 nearer.
- 25% of the gap is 1.25. Because 2.00 is more than 1.25, the stream re-centres to 105.

If the price had moved to 102.60, the difference would be 0.20, which is less than 1.25. The stream would stay on 100. This stops the stream from churning when the price hovers near a midpoint between two strikes.

### Subscriptions

The stream subscribes to quotes and trades for the set. When the set changes, it subscribes to the new contracts and unsubscribes from the ones that left. It does not reconnect for a change.

The stream is open only in the market-data window, 09:25–16:05 New York time, trading days.

### Connection

- Endpoint: `wss://stream.data.alpaca.markets/v1beta1/opra`. The feed is set by `ALPACA_OPTIONS_FEED` (default `opra`).
- Messages are MessagePack. The client authenticates with the same key and secret as the stock stream.
- On disconnect the stream reconnects with backoff, the same way the stock stream does.
- `OPTIONS_STREAM=0` turns the stream off. The sweep still runs.

For each contract the stream keeps the latest quote and trade in memory. It computes implied volatility and the greeks from each quote, at most once a second per contract.

## The 5-minute sweep

Every 5 minutes during the regular session, the sweep takes a snapshot of the option chain of each underlying in the universe.

| Setting | Default | Meaning |
| --- | --- | --- |
| Expiries | 60 days or less | `OPTIONS_SWEEP_MAX_DTE` |
| Strikes | Within ±15% of the price | `OPTIONS_SWEEP_STRIKE_RANGE` (as a fraction, 0.15 = 15%) |

Per underlying the sweep:

1. requests the snapshot for the expiries and strikes in the window,
2. computes the implied volatility of the ATM contracts and the 30-day IV,
3. computes the metrics described below and stores them as the underlying's latest `OptionMetrics`,
4. updates the stream selection with the new price.

Requests run with a concurrency limit, so the sweep does not flood the API. A sweep that runs past 5 minutes lets the next tick pass. The following sweep then starts on its own schedule.

Each sweep also updates today's row in `iv_history` (see [Storage](#storage-and-retention)).

## Metrics

Each underlying has one `OptionMetrics` record, updated by every sweep. The type is defined in [`server/src/scan/contracts.ts`](../server/src/scan/contracts.ts).

| Field | Meaning |
| --- | --- |
| `underlying` | The stock ticker. |
| `asOf` | When the sweep produced the record (ISO time). |
| `price` | The underlying price the sweep used. `null` when there was none. |
| `atmExpiry` | Expiry of the streamed at-the-money pair. |
| `atmCall` | OCC symbol of the streamed ATM call. |
| `atmPut` | OCC symbol of the streamed ATM put. |
| `atmIv` | Implied volatility of the ATM pair, annualised. `0.35` means 35%. |
| `iv30` | Constant-maturity 30-day ATM implied volatility, interpolated between the two expiries around 30 days. |
| `ivRank` | Where `iv30` sits in its own range over the last up to 252 trading days, 0 to 100. `null` until there are 20 days of history. See [IV rank and percentile](#iv-rank-and-percentile). |
| `ivPercentile` | Share of the last up to 252 trading days on which `iv30` was lower than today, 0 to 100. Same window and same `null` rule as `ivRank`. |
| `ivHistoryDays` | How many days of IV history the record is based on. |
| `hv20` | 20-day realised volatility from daily closes, close-to-close, annualised. |
| `impliedMovePct` | ATM straddle mid price divided by the underlying price, times 100, for `atmExpiry`. A rough size of the move the options price in. |
| `termSlope` | IV at about 60 days minus IV at the front expiry, in volatility points. Positive means the curve rises with time. |
| `putCallVolumeRatio` | Put volume divided by call volume over the contracts the sweep requests. |
| `unusual` | Contracts with unusually heavy volume (see below). Each entry has `occ`, `volume`, `openInterest` and `ratio`. |
| `atmCallQuote` | Bid, ask and delta of the streamed ATM call. `null` when not streamed. |
| `atmPutQuote` | Bid, ask and delta of the streamed ATM put. `null` when not streamed. |

### Unusual activity

A contract is listed in `unusual` when its volume is at least 2 times its open interest **and** at least 500 contracts. `ratio` is volume divided by open interest. It is `null` when open interest is not available.

### Definitions used in the metrics

- **Implied volatility** is the volatility that makes the option's model price equal its mid price. It is solved by Newton's method, with bisection as the fallback. It is `null` when the mid is below the option's intrinsic value or when there is no bid.
- **Model.** European Black-Scholes with a continuous dividend yield. The risk-free rate is `RISK_FREE_RATE` (default 0.04).
- **Greeks.** Delta, gamma, theta and vega. Theta is per day. Vega is per volatility point.
- **Realised volatility** (`hv20`) is 20-day close-to-close volatility, annualised.

## IV rank and percentile

`ivRank` and `ivPercentile` compare today's `iv30` with the history of `iv30` on the same underlying.

- **Window.** Up to 252 trading days. Fewer days are used when there is less history.
- **Rank.** Where today's value sits between the lowest and highest value in the window: 0 is the lowest, 100 is the highest.
- **Percentile.** The share of days in the window on which `iv30` was below today's value.

**Caveat: the history starts when the app starts recording it.** The stored history is built from the app's own sweeps. The record is written from the last sweep of each trading day, after 15:55 New York time, and updated by later sweeps that day. A new install therefore has no rank for about 20 trading days. Until then `ivRank` and `ivPercentile` are `null`, and `ivHistoryDays` shows how many days are stored.

Because of this, a `null` rank is normal on a new install. It is not an error. The scan engine handles it by using `iv30` against `hv20` instead (see [Options scorecard](scan-engine.md#setups)).

## Storage and retention

| Data | Table | Kept | Written |
| --- | --- | --- | --- |
| Minute bars of each option contract: bid, ask, mid, last, volume, IV and delta | `option_minute_bars` (in the minute-bar database, `data/minute_bars.db`) | `OPTION_BARS_RETENTION_DAYS` days (default 90). Older rows are pruned once a day. | Flushed to disk every few seconds from the stream |
| Daily IV: `iv30`, ATM IV and `hv20` per underlying per day | `iv_history` (in the main database) | Not pruned | After 15:55 each trading day, then updated by later sweeps |
| Latest `OptionMetrics` per underlying | `option_metrics` (in the main database) | Latest only, replaced on each sweep | Each sweep |

The minute bars are the only data that grows quickly. At the defaults, retention keeps about three months of option history.

## Endpoints

All routes are under `/api/options-data` and need the `x-api-key` header.

| Route | Returns |
| --- | --- |
| `GET /api/options-data/stream` | Stream status and the contracts it is subscribed to. |
| `GET /api/options-data/metrics/:symbol` | The latest `OptionMetrics` for one underlying. |
| `GET /api/options-data/iv/:symbol?days=` | The daily IV history for one underlying. `days` is the number of recent days to return. |
| `GET /api/options-data/bars/:occ?from=&to=` | Stored minute bars for one contract, between `from` and `to`. |

### Stream status

`/stream` reports the status of the connection:

| Field | Meaning |
| --- | --- |
| Connected | Whether the stream is connected now. |
| Subscribed | How many contracts are subscribed. Never more than `OPTIONS_STREAM_MAX`. |
| Messages per minute | Recent message rate. |
| Last error | The most recent error, or none. |

The scan status route (`/api/scan/status`) includes the same status under `options`. See [scan engine: status](scan-engine.md#status).

### Metrics example

`/metrics/AAPL` returns the record described in [Metrics](#metrics). A short example, with illustrative values:

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
  "termSlope": 0.012,
  "putCallVolumeRatio": 0.84,
  "unusual": [],
  "atmCallQuote": { "bid": 3.40, "ask": 3.55, "delta": 0.51 },
  "atmPutQuote": { "bid": 3.20, "ask": 3.35, "delta": -0.49 }
}
```

Here `ivRank` and `ivPercentile` are `null` because there are only 6 days of history.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPTIONS_STREAM` | `1` | `0` turns off the live stream. The sweep and the metrics keep running. |
| `ALPACA_OPTIONS_FEED` | `opra` | Alpaca options feed for the stream. |
| `OPTIONS_STREAM_MAX` | `1000` | Most contracts the stream subscribes to. |
| `OPTIONS_STREAM_MIN_DTE` | `7` | Shortest expiry, in days, used for the streamed pair. |
| `OPTIONS_SWEEP_MAX_DTE` | `60` | Longest expiry, in days, the sweep requests. |
| `OPTIONS_SWEEP_STRIKE_RANGE` | `0.15` | The sweep requests strikes within this fraction of the price on each side. |
| `RISK_FREE_RATE` | `0.04` | Risk-free rate for the option model. |
| `OPTION_BARS_RETENTION_DAYS` | `90` | Days of option minute bars to keep. |

`SCAN_ENABLED=0` also turns off the sweep and the options scorecards. See [scan engine: settings](scan-engine.md#settings).
