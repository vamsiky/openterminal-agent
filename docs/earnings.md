# Earnings setups

The earnings store answers one question for each US-listed stock that reports on a given day: is a call bought before the report and sold before the announcement worth taking? It does that at three horizons:

- **Report day (`intraday`).** Buy the call at 10:00 ET on the last full session before the announcement, sell it at 15:45 ET the same session.
- **Week ahead (`week`).** Buy about 5 sessions before that session, sell at 15:45 ET on it.
- **Month ahead (`month`).** Buy about 20 sessions before, sell at 15:45 ET on it.

Every horizon exits before the announcement. The store does not look at what happens after the report. The scoring, the screens and the routes are built on the past events in the store, plus the live option quotes when they exist.

**Setups are candidates, not orders.** Nothing in this feature places, modifies or cancels an order. It reads market data and writes to `data/earnings.db`. The agent review adds news and judgement, and it only ever proposes buying calls, or selling a put or a covered call. It never proposes buying puts.

Contents: [Data sources](#data-sources) · [Definitions](#definitions) · [Event confirmation](#event-confirmation) · [Storage](#storage) · [Backfill](#backfill) · [Jobs](#jobs) · [Scoring](#scoring) · [Routes](#routes) · [MCP tools](#mcp-tools) · [Review agent](#review-agent) · [Earnings tab](#earnings-tab) · [Limitations](#limitations)

Related: [scan engine](scan-engine.md) (the stock and option scorecards this does not replace), [options data](options-data.md) (the live option stream and sweep), [analysis agents](agents.md) (the agent runtime and budget the review uses) and [research API](research-api.md) (the `x-api-key` header used in the examples below).

## Data sources

| Source | What it supplies | Notes |
| --- | --- | --- |
| FMP `earnings-calendar` and `earnings` with `includeReportTimes=true` | Report dates, report time (`bmo`, `amc` or null), `confirmed`, fiscal period and year, period ending, EPS and revenue actual and estimate | Per-symbol history reaches back to about 2017. FMP is the source of the dates. |
| FMP `earning-call-transcript-dates`, press releases | Confirmation checks for past dates. The press release also infers the report time when FMP has none. | See [Event confirmation](#event-confirmation). |
| FMP grades and price-target news | Analyst actions for names reporting in the next 60 days and for watchlist names | Stored in `analyst_actions`. |
| Alpaca SIP stock bars | Daily bars (the app's `daily_bars` table) and 15-minute bars for the 10:00 and 15:45 anchors | 15-minute bars are requested in batches, one multi-symbol request per date. |
| Alpaca historical option bars | Daily and 15-minute bars of option contracts from about February 2024 | Option bars start around February 2024. Earlier events have stock paths but no option paths. |
| Alpaca trading API, `GET /v2/options/contracts` | Contract listings. Expired contracts come from `status=inactive`. | Read-only. The allow-list stays GET-only. |
| Alpaca option snapshots (REST) | Live quotes, IV, volume and open interest for the next two expiries, every 30 minutes around each report | REST only. The OPRA stream and its 1,000-contract budget are not used here. |

The stock side covers every US-listed common stock in `bulk_profiles` (NYSE, NASDAQ and AMEX, actively trading, not an ETF or fund). Names with no listed options get the stock side only, and their setups fail the `no_options` gate.

## Definitions

### Report time and T0, R

- **Report time `time`:** `bmo` (before the open), `amc` (after the close), `dmh` (during market hours) or `null`.
- **`timeSource`:** `fmp` when FMP gives the time, `press_release` when the time is inferred from a press release, `null` when neither is known.
- **`timeBasis`** (optional, on `/calendar` and `EarningsSetup.upcoming`): how the time was obtained, stored in `upcoming.time_basis` by `refreshUpcoming`. `upcoming` is the upcoming row's own FMP time (`timeSource` `fmp`). `history` is the majority of the name's past FMP report times, used when the upcoming row's time is null (`timeSource` is still `fmp`, because the time came from FMP). `press_release` is a time inferred from a press release (`timeSource` `press_release`). `null` when there is no time, or on rows written before the column existed (the next upcoming refresh fills it).
- `dmh` comes only from press-release inference (a release time between 09:30 and 16:00 ET).
- **T0**, the last full session before the announcement. **R**, the reaction session, the first session after the announcement.

| Report time | T0 | R |
| --- | --- | --- |
| `amc` | the report date | the next session |
| `bmo` | the previous session | the report date |
| `dmh` | the report date | the report date |
| `null` | not set | not set |

A report date that is not a session (a weekend or holiday in the feed) moves to the next session first. Sessions come from the trading calendar, which has holidays and early closes. Events with an unknown time have no T0 and R, so they cannot be used in stats.

### Anchors

An anchor is a moment on a path. Daily anchors use the session's close (or open, for the `:open` anchors). The intraday anchors use 15-minute bars.

| Anchor | Meaning |
| --- | --- |
| `T0-20`, `T0-10`, `T0-5`, `T0-2`, `T0-1` | Close of that session, counted back from T0 |
| `T0:open` | Open of T0 |
| `T0:10:00` | Close of the 15-minute bar ending at 10:00 ET on T0 |
| `T0:15:45` | Close of the 15-minute bar ending at 15:45 ET on T0 |
| `T0:close` | Close of T0 |
| `R:open`, `R:close` | Open and close of R |
| `R+5`, `R+20` | Close of the session 5 or 20 sessions after R (stock side only) |

For the 10:00 and 15:45 anchors, if the bar that ends at the anchor is missing, the code takes the last bar that ends within 45 minutes before it. If there is no such bar, the value is null.

### Horizons

Every horizon has one entry and one exit. The exit is always `T0:15:45`.

| Horizon | Entry anchor | Exit anchor |
| --- | --- | --- |
| `intraday` | `T0:10:00` | `T0:15:45` |
| `week` | `T0-5` (close) | `T0:15:45` |
| `month` | `T0-20` (close) | `T0:15:45` |

The option paths store legs for six entry anchors (`T0-20`, `T0-10`, `T0-5`, `T0-2`, `T0-1`, `T0:10:00`), so the same event can be read at other entries later. The stats and scores use only the three entries above.

### Expiry kinds

| Where | Kinds | Meaning |
| --- | --- | --- |
| Option paths | `event` | The first listed expiry on or after R |
| Option paths | `swing` | The first expiry at least 21 calendar days after R. It survives the event and is kept for later after-report horizons. |
| Snapshots | `event` | The first expiry on or after R (same as the path kind) |
| Snapshots | `next` | The expiry after the event expiry |

### Legs

A leg is one option contract on one entry. Each entry gets up to three legs for each expiry kind:

| Leg | Choice at entry |
| --- | --- |
| `atm_call` | The call strike nearest the spot at entry that has a price at entry. The search looks at the nearest three strikes. Ties go to the lower strike. |
| `otm_call` | The next strike above the `atm_call`, that has a price at entry. The search looks at two strikes. |
| `atm_put` | The put strike nearest the spot, as for `atm_call`. Used for put-selling research only. |

**A leg is fixed at entry and tracked to exit.** The contract is picked once, then its price is read at every later anchor through `R:close`. Nothing is re-centred. A leg is stored only when it has a price at entry. Its `prices` map holds the contract's price at the entry and at each later anchor. `ivAtEntry` is solved from the entry price with the repo's Black-Scholes solver.

`priceSource` is `trade` for paths built from historical bars. Those prices are last trades, not quotes. It is `quote` for legs rolled up from live snapshots (see [Jobs](#jobs)).

## Event confirmation

FMP lists dates that do not always match the day the stock moved. Each (symbol, FMP date) pair is checked before it is used. The four checks are stored with the event:

| Check | Passes when |
| --- | --- |
| `fmp` | FMP lists the date with an `epsActual`. Always true for stored events. |
| `transcript` | FMP's call-transcript dates contain the report date. For `amc` calls, a date one calendar day either side also passes. |
| `press_release` | An FMP press release with an earnings-like title (the existing regex) is dated the report date. For `bmo`, one dated the evening before also passes. The check runs only when the transcript and volume checks both fail, or when the time has to be inferred. |
| `volume` | R's volume is at least 1.5 times the median volume of the 20 sessions before T0, or R's opening gap is at least 1.5 times the average absolute daily move over the same 20 sessions. The baseline needs at least 10 sessions. |

Rules that set the stored result:

- **Confirmed:** `fmp` plus at least one other check, and R has a bar. `confirmed = true`, `reason = "ok"`.
- **Unconfirmed:** the other checks all fail. `confirmed = false`, `reason = "unconfirmed"`. Stats skip these.
- **`date_shifted`:** the volume check fails on FMP's date and no transcript is dated on that date, and one adjacent trading day (before or after) has a volume ratio of at least 1.5 that is higher than FMP's date's. The code stores the corrected date as `report_date`, keeps FMP's original in `original_date`, and sets `reason = "date_shifted"`. A transcript dated exactly on FMP's date blocks a shift. Large caps can react by less than 1.5 times on their real date, and the transcript is the evidence for that date.
- **`no_bars`:** the events have a T0 and R, but R has no daily bar. The nightly job retries these for 10 days.
- **Time unknown:** the event has no T0 and R. It is stored with `reason = "unconfirmed"`, which is not confirmed in the sense above.

Stats use confirmed events only. Option paths are built only for confirmed events.

## Storage

All tables live in `data/earnings.db` (under `DATA_DIR`, in WAL mode). The file is separate from `terminal.db` so that the backfill and the snapshot writes do not hold its lock. Dates are text `YYYY-MM-DD`, timestamps are ISO UTC, prices are REAL.

| Table | Key | What it holds |
| --- | --- | --- |
| `events` | `(symbol, report_date)` | One row per FMP report: time and its source, T0, R, fiscal fields, EPS and revenue actual and estimate, the four checks, `confirmed`, `reason`, FMP's own `confirmed` flag, and `original_date` when the date was shifted |
| `stock_paths` | `(symbol, report_date)` | One column per stock anchor (`t0_m20` … `r_p20`, `t0_1000`, `t0_1545`), plus `prev_close`, `r_volume_ratio` (R's volume over the 20-session median), `atr14_pct` |
| `upcoming` | `(symbol, report_date)` | The next 120 days of the FMP calendar for US-listed names, with report time, `time_source`, `time_basis`, T0, R and estimates. Replaced on each nightly refresh when every window fetched. |
| `analyst_actions` | `(symbol, date, firm, action)` | Grade changes and price-target moves from the last 90 days. Price-target rows have the action `pt_raise`, `pt_cut`, `pt_set` or `pt_maintain`. |
| `option_paths` | `(symbol, report_date, entry, expiry_kind, leg)` | One `OptionLegPath` per leg. `prices` is JSON keyed by anchor. |
| `option_ladder_bars` | `(occ, day)` | Daily bars of the strike ladder, from 25 sessions before T0 to the session after R. Kept so windows can be recomputed without another fetch. |
| `option_intraday_bars` | `(occ, ts)` | 15-minute bars for the ATM call pair (one strike each side) and the ATM put, on T0-1, T0 and R, for both expiry kinds, plus the event-expiry contracts the daily entries picked |
| `snapshots` | `(symbol, ts, expiry_kind)` | Live summaries: spot, ATM call and put bid, ask, IV, volume and open interest, the next-strike call, deltas, the implied move (straddle mid over spot) and the event premium. Pruned after the report. |
| `stats` | `(scope_key, horizon, time)` | `EventStats` as JSON, rebuilt after each nightly run and each completed backfill. Scope keys: `sym:WDC`, `pool:Technology:mid`, `cap:mid`, `all`. |
| `reviews` | `id` | `EarningsReview` rows from the agent, including errors |
| `review_queue` | `(day, symbol, horizon, report_date)` | Reviews waiting for budget or running. Created by the review module, not in `db.ts`. |
| `backfill_progress` | `(task, symbol)` | Resume state for the tasks `events`, `stock`, `options`, `analyst`, and `nightly` (one row, symbol `last`) |

Indexes: `events(report_date)`, `upcoming(report_date)`, `snapshots(ts)`, and `reviews(report_date, horizon, symbol)`.

Disk use: measured after the full US backfill (5,504 names), `earnings.db` is 1.21 GB (1,206,222,848 bytes, WAL checkpointed). Rows: 144,138 events, 135,171 stock paths, 482,786 option legs, 5,868,630 ladder bars, 3,883,680 intraday option bars, 37,237 stats scopes, 3,363 upcoming rows and 21,610 analyst rows. That is well under the 5 GB target. Growth per year has not been measured yet; the target is under 1.5 GB a year, with snapshot rows pruned once they roll up.

## Backfill

The backfill is a command-line tool. It fills the store for past events and resumes where it stopped.

```sh
# Everything for every US-listed name (events, stock paths, option paths, then the upcoming
# calendar, the analyst actions and the stats):
npm run backfill-earnings -w server -- --phase all

# Only the event confirmation step:
npm run backfill-earnings -w server -- --phase events

# A few symbols, redone from scratch (an explicit --symbols list ignores progress):
npm run backfill-earnings -w server -- --symbols WDC,RNG,MXL --phase all

# Events from a given report date onward (default 2017-01-01):
npm run backfill-earnings -w server -- --phase events --since 2024-02-01
```

Flags:

| Flag | Values | Default |
| --- | --- | --- |
| `--phase` | `events`, `stock`, `options`, `upcoming`, `all` | `all` |
| `--mark-complete` | flag; no other options | off |
| `--symbols` | comma-separated tickers | every US-listed name in `bulk_profiles` |
| `--since` | `YYYY-MM-DD` | `2017-01-01` |

What each phase does, in order:

1. **events.** For each symbol, reads FMP's per-symbol history (up to 80 reports), runs the checks and stores each event. Twelve symbols run at once.
2. **stock.** Builds the stock paths for the stored events, in passes of up to 1,500 symbols. Each pass fetches the 15-minute bars one date at a time, several symbols per request.
3. **options.** For each symbol's confirmed events from `--since` on, lists the contracts, fetches the daily ladder and the intraday bars, and writes the option legs. Six symbols run at once.
4. **upcoming and analyst (only with `--phase all`).** Fills the upcoming calendar and the analyst actions.
   `--phase upcoming` runs only the upcoming-calendar refresh (it needs the FMP key only), for refreshing report times and their basis without the nightly job.
5. **stats.** Rebuilds every `stats` scope. This runs after every run, whatever the phase.

**Warning on `--since` and the options phase.** The options phase uses the same `--since` value as the events phase. The default `2017-01-01` therefore asks Alpaca for contracts and bars for events back to 2017. Alpaca's option bars start around February 2024, so the earlier requests return nothing. Pass `--since 2024-02-01` for the options phase, or run the phases separately.

### Phase markers and `--mark-complete`

A run without `--symbols` records `backfill_progress` markers: task `run` (symbol `all`, `updated_at` = run start, detail has the universe size, written by `--phase all`) and task `phase` (symbol `events`, `stock` or `options`; status `running` while the phase works, `done` with the finish time when it ends with no error rows). `/status` reads these: a phase that has started without its `done` marker is the running phase, and the backfill is `done` when all three markers are newer than the run start. The universe changes daily as listings change, so the per-task symbol counts can differ by a few names; that does not matter to the markers. Names that list later are covered by the nightly job.

A database whose backfill finished before the markers existed has none, and `/status` falls back to counts (a task at 99% of the largest count, and no error rows, is complete). To write the markers once for such a database:

```sh
npm run backfill-earnings -w server -- --mark-complete
```

It verifies that each of the three tasks has at least 99% of the largest done count and no error rows, then writes the markers (run start = the earliest progress row, phase finish = the latest row of each task). It fails with the reason otherwise, and writes nothing.

### Resume and re-runs

- A symbol finished in the events phase is recorded in `backfill_progress` and skipped next time. The stock phase does the same. Naming symbols with `--symbols` redoes them.
- The options phase records the last report date it covered for each symbol. It also skips any event that already has option paths.
- Every write is an upsert, so a re-run after a crash is safe.
- A symbol that errors is recorded with status `error` and retried on the next run.
- Progress is printed every 100 symbols in the events phase, with a rate per minute.

### Request caps and environment variables

| Variable | Default | What it caps |
| --- | --- | --- |
| `EARNINGS_BACKFILL_ALPACA_PER_MIN` | 2500 | Alpaca requests per minute, for this CLI process only |
| `EARNINGS_BACKFILL_FMP_PER_MIN` | 1500 | FMP requests per minute, for this CLI process only |
| `ALPACA_MAX_REQ_PER_MIN` | from `.env` | Alpaca requests per minute for the running server (the nightly job, the snapshots and the live app) |
| `FMP_MAX_REQ_PER_MIN` | from `.env` | FMP requests per minute for the running server |

The CLI sets the two `ALPACA_MAX_REQ_PER_MIN` and `FMP_MAX_REQ_PER_MIN` values for its own process from the `EARNINGS_BACKFILL_*` variables. The live server reads its own `.env` values, so it keeps its headroom while the backfill runs in another process. The default backfill cap of 2500 leaves room under Alpaca's 5,000 per minute for the live sweep.

The backfill needs `FMP_API_KEY` and the Alpaca key pair, and exits with an error if either is missing.

Measured run (2026-10-22, 07:12 to 09:15 UTC, about 2 h 03 min in total, 5,503 symbols with 5,504 in the option phase): events 31 min (144,156 events: 122,873 confirmed, 640 shifted, 21,192 unconfirmed, 11,985 skipped, 0 errors; about 180 symbols a minute, FMP requests, roughly 50,000), stock 4.5 min (135,171 paths, about 1,200 Alpaca data requests per 200 symbols), options 83 min (29,310 events, 482,786 legs, 72,428 requests: 16,872 contract listings on the trading API and 55,556 bar requests; 4 errors, all Alpaca 429s on contract listings, cleared by a re-run of `--phase options`), then the upcoming and analyst fill (3,363 upcoming rows, 21,649 analyst rows, about 6,000 FMP requests) and the stats rebuild (37,237 scopes in 6.2 s). The options phase averaged about 870 requests a minute, well under the 2,500 a minute cap.

## Jobs

The jobs start with the API server. Set `EARNINGS_JOBS_ENABLED=0` to stop all three of them. The routes stay up.

### Nightly, 18:30 New York time

The job checks every 5 minutes. It runs once per trading day, on the first check after 18:30 ET. It does the following, in order. A failed step is logged and counted, and the later steps still run.

1. Loads the year's trading calendar.
2. Finds the symbols that reported in the last 7 days (FMP calendar, with an `epsActual`, US-listed only). It adds symbols with `no_bars` events from the last 10 days.
3. Runs the events phase for those symbols since 30 days back, redoing them.
4. Runs the stock phase for the same symbols.
5. Refreshes the upcoming calendar (120 days).
6. Refreshes analyst actions for names reporting in the next 60 days, plus watchlists. A name reporting within 10 days is refetched daily, others weekly.
7. Builds option paths for the events that were new in step 3.
8. Rebuilds the stats.

It writes one summary line to the log, and a `nightly` row to `backfill_progress` with the count of new events.

### Snapshots

The snapshot job checks every 20 seconds. A slot runs when the check lands within 4 minutes after its nominal time, New York time, on a trading day.

| Slot | Time (ET) | Which names |
| --- | --- | --- |
| Near | 09:45, 10:15, 10:45 … 15:45 (13 slots) | Names whose T0 is within the next 10 sessions |
| Far | 15:50 | Names whose T0 is 11 to 45 sessions out |
| Close | 16:10 | Roll-up and prune (no names) |

For each name in a snapshot slot, the job reads the stock price in batches of 200 symbols, then requests the option chain once per name (up to four pages). It keeps the strikes within 10% of spot, and the expiries from R to R+35 calendar days. It stores two rows per name: `event` and `next`. Each row holds the ATM pair (the strike nearest spot that has both a call and a put), the next strike up on the call side, and the implied move. The `event` row also holds the event premium (the event expiry's IV over the next expiry's).

A name whose chain has no ATM call and put pair in that window is skipped for the rest of that day.

**Close slot (16:10).** For every event whose R is before today, the job copies the ATM call and put quotes at the entry anchors into `option_paths`. The leg gets `priceSource: "quote"` when there is no trade-based leg. A trade-based leg is only filled in where it has gaps, and only from the same contract. The job then deletes snapshot rows whose report date is more than 31 days before today, and snapshot rows with no report date that are more than 90 days old.

### Review worker

The review worker runs every 60 seconds. It works through the review queue while the daily budget has room (see [Review agent](#review-agent)). A `POST /review` also starts it straight away.

### The kill switch

`EARNINGS_JOBS_ENABLED=0` stops the nightly job, the snapshots and the review worker. `POST /review` still queues and runs reviews after it returns. That is because the route starts the worker itself. Set `AGENTS_ENABLED=0` to stop the reviews. That also makes `POST /review` return 503.

## Scoring

Each setup is scored for one symbol and one horizon, for the name's next report. The score is out of 100 and is the sum of five components. Each component returns its points, its maximum, the inputs it used, and one sentence with the numbers.

The weights are in `server/src/earnings/weights.ts`. The version string on every setup is `earn-v1`. The version is a constant that must be bumped by hand when the weights change. An old score then still says which weights made it.

### Components and maxima

| Component | Intraday | Week | Month | What it measures |
| --- | ---: | ---: | ---: | --- |
| `tradability` | 25 | 20 | 15 | Whether the chosen call can be traded at a sensible cost today |
| `history` | 30 | 25 | 20 | How this name's past calls and stock moves went on this horizon, with peers as a fallback |
| `setup` | 20 | 20 | 25 | Trend, momentum and RSI as of the scorecard |
| `demand` | 15 | 20 | 25 | Recent reactions, analyst moves, last quarter's beat, revisions and pre-report drift |
| `carry` | 10 | 15 | 15 | Whether the stock needs to move more than the option costs, against a typical move |

Each horizon's maxima add to 100.

### Contract choice

The score is for one contract, chosen by `chooseContract`:

- **Intraday and week:** the lowest-spread call among the event-expiry legs (`atm_call` and `otm_call`). If there are no event-expiry legs, all legs are used.
- **Month:** the first expiry at least 25 calendar days after the entry date (the snapshot date). The lowest-spread leg of that expiry is chosen.

The spread is `(ask − bid) ÷ mid`, in percent. A tie goes to the higher volume.

### Tradability (`tradability`)

- Points = max × (1 − spread% ÷ 30). A 0% spread gets the full max. A 30% spread gets 0.
- Minus 5 points when today's contract volume is under 50, floored at 0.
- No two-sided quote gives 0 points.

### History (`history`)

- **Own stats** are the symbol's `EventStats` for this horizon and report time. The time-specific slice is used when it has at least 3 events. Otherwise the `any` slice is used.
- **Pooled stats** are the sector × cap pool when it has at least 20 events. Otherwise the cap bucket alone. Otherwise all events.
- **Shrinkage.** Each median and win rate is blended as `(n × own + k × pooled) ÷ (n + k)`, with `k = 5`. With no own events, the pooled value is used alone.
- **Call part** = (max − 10) × clamp((blended call median + 10) ÷ 20, 0, 1). A median of −10% gives 0. A median of +10% or more gives max − 10. With no call data, half the range is used.
- **Win part** = blended stock win rate × 10. That is, the share of past events where the stock rose over the entry-to-exit window, times 10.

### Setup (`setup`)

- **Trend.** Points for each average the stock is above: 3 for the 20-day, 4 for the 50-day and 3 for the 200-day, at the intraday maximum of 20. They are scaled by max ÷ 20 for the other horizons. The 20-day average comes from daily bars. The 50-day and 200-day comes from the scorecard.
- **Momentum.** The app's momentum group score (0 to 100) ÷ 10, scaled the same way.
- **RSI penalty** (not scaled): −8 above 85, −5 above 75, −3 below 35.

### Demand (`demand`)

Each part adds points, and the total is capped at the maximum.

- **Recent reactions.** One point value for each of the last four events where the stock rose from T0 close to R close. The value is 1.5 intraday, 1 week and 1.5 month.
- **Analyst moves.** +3 (intraday), +5 (week) or +6 (month) if any price target was raised in the window. −2, −3 or −4 if any target was cut or any grade was downgraded. Grade upgrades alone do not count.
- **Last quarter.** Beat on both EPS and revenue gives 3 (intraday and week) or 4 (month). Beat on one gives 1.5 (intraday and week) or 2 (month).
- **Revisions** (week and month only). The consensus EPS change over 30 days and over 90 days, each as a share of 5%. A change of 5% or more gets the full points: 3 and 2 for week, 4 and 3 for month. A negative change takes points away.
- **Pre-report drift.** The share of past events where the T0 close was above the prior close, times 3 (intraday and week) or 2 (month).

### Carry (`carry`)

- **Break-even move** = (spread% + expected decay%) ÷ leverage. Leverage = delta × spot ÷ mid.
- **Expected decay.** When the stats have a flat-day call median for the horizon, the decay is that median's loss, that is, the negative of it, floored at 0. Otherwise it is a time-decay estimate from days to expiry, clamped between 1% and 8% (intraday) or 1% and 20% (week and month).
- **Typical move (target).** Intraday: half the 14-day ATR as a share of price. Week and month: half the interquartile range of the stock's past returns over the horizon, using own events when there are at least 5, else pooled. With no history, half the ATR scaled by the square root of the sessions.
- **Break-even points** = 10 × (1 − break-even ÷ target), floored at 0.
- **IV points** (week and month only, up to 5). The contract's IV over the name's typical IV at the entry anchor: 1.2 or more gives 0, 0.8 or less gives the full 5, and an unknown value gives 2.5.

### Gates

A failed gate sets the verdict to `pass` whatever the score is.

| Gate | Fails when |
| --- | --- |
| `spread` | The chosen contract's spread is above 15% |
| `volume` | The chosen contract traded fewer than 50 contracts today |
| `no_options` | There is no option snapshot for the name |
| `unconfirmed_time` | The report time is unknown |
| `no_quote` | There is no two-sided quote |

### Verdict bands

| Score and gates | Verdict |
| --- | --- |
| Any gate failed | `pass` |
| 70 or more | `candidate` |
| 55 to 69 | `conditional` |
| Under 55 | `pass` |

### Worked example: RNG, intraday

The numbers below are illustrative, not a live run. The spread, contract size, volume, the 5 past calls at +12.6% and the 24 of 39 stock win count are the figures this example was written around. The other inputs are chosen to be realistic. The arithmetic follows what the code does.

RNG reports after the close on 2026-10-22, so T0 is 2026-10-22 and R is 2026-10-23. The screen is for the intraday horizon.

**Contract.** The 2026-10-23 $83 call, with a bid of 2.50 and an ask of 2.80. Mid is 2.65 and the spread is 0.30 ÷ 2.65 = 11.3%. It traded 563 contracts today.

**Tradability: 15.6 of 25.** Points = 25 × (1 − 11.3 ÷ 30) = 15.57. The volume is above 50, so there is no penalty. The code keeps one decimal place, so the component shows 15.6. Shown as a whole number it is 16.

**History: 25.6 of 30.**
- Own call stats: 5 past calls, median +12.6%.
- Pooled call median: +6.6%. Blended: (5 × 12.6 + 5 × 6.6) ÷ 10 = +9.6%.
- Call part = 20 × clamp((9.6 + 10) ÷ 20) = 20 × 0.98 = 19.6.
- Own stock stats: the stock rose on 24 of 39 past reports, a win rate of 61.5%. The pooled win rate is 50%. Blended: (39 × 0.615 + 5 × 0.5) ÷ 44 = 60.2%.
- Win part = 6.0.
- History = 19.6 + 6.0 = 25.6. Shown as a whole number it is 26.

**Setup: 20.0 of 20.** The stock is above its 20-, 50- and 200-day averages: 3 + 4 + 3 = 10. Momentum score 100 gives 10. RSI is in range, so no penalty.

**Demand: 8.0 of 15.**
- 1 of the last 4 reactions was up: +1.5.
- An analyst raised a price target in the window: +3.
- Last quarter beat on EPS only: +1.5.
- 67% of past report days closed above the prior close: 0.67 × 3 = +2.0.
- Total 8.0.

**Carry: 4.0 of 10.**
- Spread 11.3%. Flat-day call median from the stats is −2.0%, so the expected decay is 2.0%.
- Spot 83.00 and delta 0.30 give leverage of 0.30 × 83.00 ÷ 2.65 = 9.4x.
- Break-even = (11.3 + 2.0) ÷ 9.4 = 1.42%.
- Typical move (target) = half of a 4.7% ATR = 2.35%.
- Points = 10 × (1 − 1.42 ÷ 2.35) = 4.0.

**Total.** 15.6 + 25.6 + 20.0 + 8.0 + 4.0 = 73.2, which rounds to **73**. The score is 73, so the verdict is **`candidate`** (70 or more). All five gates pass: spread 11.3% (under 15%), volume 563 (over 50), options listed, time known (`amc`, from FMP), and a two-sided quote.

The component reasons read like this:

> The 2026-10-23 $83 call is 11.3% wide (2.50 / 2.80) with 563 contracts traded today.
>
> 5 past intraday calls had a median of +12.6% (blended with peers +9.6%, k=5); the stock rose over this window on 24 of 39 past reports (blended win rate 60%).

## Routes

All routes are under `/api/earnings` and need the `x-api-key` header. The examples assume the API on `127.0.0.1:4000`, as in the [research API](research-api.md).

```sh
B=http://127.0.0.1:4000
KEY=$(cat data/.api-key)
```

### `GET /calendar`

Upcoming reports in a window, with the report time, estimates, the last report against its estimate, the last reaction, the implied move if snapshotted, and a flag for whether the name is tradable.

| Parameter | Meaning |
| --- | --- |
| `from`, `to` | Report-date window. Default: today (New York) to 7 days later. |
| `time` | `bmo`, `amc` or `dmh` |
| `sector`, `minCap`, `maxCap` | Profile filters. Caps are in dollars. |
| `optionable` | `true` or `false` (does the name have a live option contract) |
| `symbols` | Comma-separated tickers |

```sh
curl -s -H "x-api-key: $KEY" "$B/api/earnings/calendar?from=2026-10-22&to=2026-10-23&time=amc"
```

```json
[
  {
    "symbol": "RNG", "name": "RingCentral, Inc.", "sector": "Technology", "marketCap": 2400000000,
    "reportDate": "2026-10-22", "time": "amc", "timeSource": "fmp", "fmpConfirmed": true, "t0": "2026-10-22",
    "epsEstimate": 0.31, "revenueEstimate": 585000000, "fiscalPeriod": "Q3",
    "lastReport": { "date": "2026-07-23", "epsActual": 0.34, "epsEstimate": 0.30, "reactionPct": 4.1 },
    "lastReactionPct": 4.1, "impliedMovePct": 8.6, "optionable": true, "tradable": true
  }
]
```

The calendar scores each row on the intraday horizon, so `tradable` uses the intraday gates.

### `GET /screen`

Every matching setup, scored and sorted. **There is no default limit.** The response has every name that matches the filter. Narrow the filter or pass `limit` to cap it.

| Parameter | Meaning |
| --- | --- |
| `from`, `to` | Window by report date or T0. Default: the next session. With only `from`, the window is that day. |
| `horizon` | `intraday` (default), `week` or `month` |
| `time`, `sector`, `industry`, `minCap`, `maxCap` | Filters |
| `minScore` | 0 to 100 |
| `verdict` | `candidate`, `conditional` or `pass` |
| `tradable` | `true` for setups where every gate passes |
| `symbols` | Comma-separated tickers |
| `sort` | `score` (default), `symbol`, `cap`, `date`, `spread` or `impliedMove` |
| `limit` | Optional cap on the number of rows |

```sh
curl -s -H "x-api-key: $KEY" "$B/api/earnings/screen?from=2026-10-22&to=2026-10-22&horizon=intraday&tradable=true"
```

The response is an array of `EarningsSetup` objects. One abbreviated row (the RNG example above):

```json
[
  {
    "symbol": "RNG", "name": "RingCentral, Inc.", "sector": "Technology", "marketCap": 2400000000,
    "upcoming": { "reportDate": "2026-10-22", "time": "amc", "timeSource": "fmp", "fmpConfirmed": true, "t0": "2026-10-22", "epsEstimate": 0.31, "revenueEstimate": 585000000, "fiscalPeriod": "Q3" },
    "horizon": "intraday", "asOf": "2026-10-22T14:30:00.000Z",
    "score": 73, "verdict": "candidate",
    "components": [
      { "key": "tradability", "points": 15.6, "max": 25, "value": { "spreadPct": 11.3, "volume": 563, "expiry": "2026-10-23" },
        "reason": "The 2026-10-23 $83 call is 11.3% wide (2.50 / 2.80) with 563 contracts traded today." },
      { "key": "history", "points": 25.6, "max": 30, "value": { "callMedian": 12.6, "callN": 5, "blendedCallMedian": 9.6, "stockWinRate": 0.6154, "stockN": 39, "blendedWinRate": 0.6023 },
        "reason": "5 past intraday calls had a median of +12.6% (blended with peers +9.6%, k=5); the stock rose over this window on 24 of 39 past reports (blended win rate 60%)." },
      { "key": "setup", "points": 20, "max": 20, "value": { "vs20": 3.1, "vs50": 5.4, "vs200": 12.0, "rsi": 58, "momentum": 100 },
        "reason": "Above its 20/50/200-day averages (20d +3.1%, 50d +5.4%, 200d +12.0%), momentum score 100." },
      { "key": "demand", "points": 8, "max": 15, "value": { "upReactionsOfLast4": 1, "analystRaise": true, "analystCut": false, "epsBeat": true, "revenueBeat": false, "driftUpShare": 0.6667 },
        "reason": "1 of the last 4 reactions were up (+1.5); analyst targets raised in 10 days (+3); last quarter beat on EPS only (+1.5); 67% of past report days closed above the prior close (+2.0)." },
      { "key": "carry", "points": 4.0, "max": 10, "value": { "breakevenPct": 1.42, "decayPct": 2.0, "leverage": 9.4, "targetMovePct": 2.35, "ivVsTypical": 0.94 },
        "reason": "Break-even stock move is 1.42% ((11.3% spread + 2.0% expected decay) / 9.4x leverage) against a typical move of 2.35%." }
    ],
    "gates": [
      { "key": "spread", "passed": true, "reason": "Spread 11.3% is within the 15% limit." },
      { "key": "volume", "passed": true, "reason": "563 contracts traded today (minimum 50)." },
      { "key": "no_options", "passed": true, "reason": "Listed options found." },
      { "key": "unconfirmed_time", "passed": true, "reason": "Report time is AMC (fmp)." },
      { "key": "no_quote", "passed": true, "reason": "Two-sided quote present." }
    ],
    "contract": { "occ": "RNG261023C00083000", "expiry": "2026-10-23", "strike": 83, "bid": 2.5, "ask": 2.8, "mid": 2.65, "spreadPct": 11.3, "iv": 0.62, "delta": 0.30, "volume": 563, "openInterest": 4100, "leverage": 9.4, "breakevenStockMovePct": 1.42 },
    "live": { "price": 83.0, "impliedMovePct": 8.6, "eventPremium": 1.12, "ivVsTypicalAtAnchor": 0.94 },
    "history": { "own": { "...": "EventStats" }, "pooled": { "...": "EventStats" }, "blended": { "callMedian": 9.6, "stockWinRate": 0.6023, "k": 5 } },
    "lastReport": { "date": "2026-07-23", "epsActual": 0.34, "epsEstimate": 0.30, "revenueActual": 601000000, "revenueEstimate": 590000000, "reactionPct": 4.1 },
    "revisions": { "eps30d": 1.2, "eps90d": -0.8, "revenue30d": 0.4 },
    "analyst": [ { "date": "2026-10-20", "firm": "Example Research", "action": "pt_raise", "priceTarget": 95 } ],
    "weightsVersion": "earn-v1"
  }
]
```

The numbers in that row other than those named in the worked example are illustrative.

### `GET /setup/:symbol`

The setup for the symbol's next report, on the horizon given (`horizon=intraday` by default). Returns 404 when there is no upcoming report.

```sh
curl -s -H "x-api-key: $KEY" "$B/api/earnings/setup/RNG?horizon=week"
```

The response is one `EarningsSetup` object, the same shape as a screen row. When the store has no snapshot for the name, this route asks Alpaca for the live chain of the event expiry and the one after it. The screen does not do that. A name with no stored snapshot therefore shows `no_options` on the screen and may pass on this route.

### `GET /events/:symbol`

Past events of a symbol, newest first, each with its stock path and its option legs.

| Parameter | Meaning |
| --- | --- |
| `from` | Earliest report date. Default `1900-01-01`. |
| `confirmed` | `true` for confirmed events only, `false` for unconfirmed only |

```sh
curl -s -H "x-api-key: $KEY" "$B/api/earnings/events/RNG?from=2024-01-01&confirmed=true"
```

Each element has the event fields (`reportDate`, `time`, `t0`, `r`, `epsActual`, `epsEstimate`, `revenueActual`, `revenueEstimate`, `confirmed`, `checks`, `reason`, `fmpConfirmedFlag`), a `stock` object keyed by anchor (`"T0-5"`, `"T0:15:45"`, `"R:close"` and so on, plus `prevClose`, `rVolumeRatio` and `atr14Pct`), and an `options` array of `OptionLegPath` objects.

### `GET /stats`

Historical distributions for one scope.

| Parameter | Meaning |
| --- | --- |
| `horizon` | `intraday` (default), `week` or `month` |
| `symbol` | One symbol |
| `sector`, `capBucket` | A pool. `sector` needs `capBucket`. |
| `capBucket` alone | `micro`, `small`, `mid`, `large` or `mega` |
| `time` | `bmo`, `amc`, `dmh` or `any` (default) |

With no scope, the route returns the stats for all events. It returns 404 when no stats exist for the scope.

```sh
curl -s -H "x-api-key: $KEY" "$B/api/earnings/stats?horizon=intraday&sector=Technology&capBucket=mid&time=amc"
```

The response is an `EventStats` object: `n`, `nOptions`, `stock` and `call` distributions (each with `n`, `median`, `mean`, `p25`, `p75`, `winRate`), `otmCall`, `callBeta` and `callAlpha` (a fit of call return on stock return, needs at least 5 events), `flatDayCall` (the median call return on days when the stock moved less than 0.6%), `preDrift`, `impliedVsRealized`, `ivRamp` and `reactions` (the up share, the median absolute move and the last four moves).

### `GET /status`

Backfill progress, the nightly job, the snapshots and the database size.

```sh
curl -s -H "x-api-key: $KEY" "$B/api/earnings/status"
```

```json
{
  "backfill": { "phase": "options", "phases": { "events": { "done": 4800, "total": 4800, "finishedAt": "..." }, "stock": { "done": 4800, "total": 4800, "finishedAt": "..." }, "options": { "done": 1200, "total": 4800, "finishedAt": null } }, "symbolsDone": 1200, "symbolsTotal": 4800, "eventsStored": 61000, "eventsConfirmed": 52000, "optionEvents": 18000, "startedAt": "...", "updatedAt": "...", "errors": 3 },
  "nightly": { "lastRun": "2026-10-21T22:30:04.000Z", "newEvents": 14 },
  "snapshots": { "lastRun": "2026-10-22T14:30:02.000Z", "namesTracked": 420, "rowsToday": 812 },
  "db": { "sizeBytes": 123456789 }
}
```

The numbers above are placeholders. `phase` is `idle` before any backfill, the running or first unfinished phase (`events`, `stock` or `options`), or `done`. It comes from the completion markers (see Phase markers); without markers it falls back to the done counts. `phases` gives `{ done, total, finishedAt }` for each of `events`, `stock` and `options` (`total` is the universe size at the run, never below `done`; `finishedAt` is null until the phase's marker is newer than the run start).

### `POST /review`

Queues the earnings agent for every setup that matches. The default filter is "gates passed".

Body:

| Field | Meaning |
| --- | --- |
| `horizon` | Required: `intraday`, `week` or `month` |
| `symbols` | Optional list of tickers |
| `filter` | Optional screen parameters (the same as `/screen`) |
| `dryRun` | `true` to count without queueing |

A dry run:

```sh
curl -s -X POST -H "x-api-key: $KEY" -H "content-type: application/json" "$B/api/earnings/review" \
  -d '{"horizon":"intraday","filter":{"from":"2026-10-22","to":"2026-10-22"},"dryRun":true}'
```

```json
{ "queued": 0, "wouldQueue": 38, "skipped": 3, "estimatedCostUsd": 5.7, "fitsToday": 9 }
```

A real run returns status 202 with `queued` and `estimatedCostUsd`, and starts the worker straight away. Each queued item is one review. The estimate is the count times `EARNINGS_REVIEW_MAX_USD` (the per-run cap, $0.15 by default). It is an upper bound. `skipped` counts setups already queued or reviewed today. `fitsToday` is how many reviews the remaining daily budget can start.

Status codes:

- **200:** a dry run.
- **202:** queued.
- **402:** matching setups exist and the daily budget cannot fit even one review. This check also applies to a dry run.
- **503:** `AGENTS_ENABLED=0`.

Because the default filter is gates passed, a single symbol that fails a gate queues nothing. The review button in the Earnings tab uses this route the same way.

### `GET /reviews`

Reviews, newest first.

| Parameter | Meaning |
| --- | --- |
| `reportDate` | One report date |
| `from`, `to` | A report-date range |
| `horizon` | `intraday`, `week` or `month` |
| `symbol` | One symbol |
| `limit` | Up to 5000. No limit by default. |

```sh
curl -s -H "x-api-key: $KEY" "$B/api/earnings/reviews?from=2026-10-22&to=2026-10-23&horizon=intraday"
```

The response is an array of `EarningsReview` objects. The review's `baseScore` is the score the code computed, and `adjustedScore` is that score plus the agent's adjustment.

## MCP tools

The six tools below are on the terminal's MCP server. They are read-only. The screen and setup tools read the same routes as above. `POST /review`, `/status` and the snapshot status have no tool.

| Tool | Arguments | Notes |
| --- | --- | --- |
| `earnings_calendar` | `symbols` (1 to 100, optional), `from`, `to` (dates), `time` (`bmo`, `amc`, `dmh`), `sector`, `minCap`, `maxCap` (numbers), `optionable` (boolean) | With only `symbols`, it calls the older calendar route (next report date and timing with estimates). With any of the other arguments, it calls `/api/earnings/calendar`. |
| `earnings_screen` | `from`, `to`, `horizon` (`intraday`, `week`, `month`), `time`, `sector`, `industry`, `minCap`, `maxCap`, `minScore` (0 to 100), `verdict`, `tradable` (boolean), `symbols` (up to 500), `sort` (`score`, `symbol`, `cap`, `date`, `spread`, `impliedMove`), `limit` | Every match, with no default limit. Default window: the next session. |
| `earnings_setup` | `symbol` (required), `horizon` | The setup for the next report. 404 when none is upcoming. |
| `earnings_events` | `symbol` (required), `from`, `confirmed` (boolean) | Past events with the checks, the stock path and the option legs |
| `earnings_stats` | `horizon`, `symbol`, `sector`, `capBucket`, `time` | The same scopes as `GET /stats`. `sector` needs `capBucket`. |
| `earnings_reviews` | `reportDate`, `from`, `to`, `horizon`, `symbol`, `limit` (1 to 1000) | Agent reviews, read-only |

The MCP responses are compact JSON. Long answers are cut and marked, so ask for fewer rows or add a filter.

## Review agent

The review agent adds the parts a stored number cannot know: recent news, the macro context, what management said on the latest call, and a judgement on whether that changes the odds of a rise between entry and exit. It runs through the same runtime as the [analysis agents](agents.md). It uses the same daily budget and the same per-run cap settings.

**What it adds.** Only news, macro and judgement. It never recomputes or changes a number from the setup. Its input is the setup itself, serialised into the prompt, and the prompt says so.

**Tools.** `earnings_setup` (once, to check the setup), `market_news`, `macro`, `quote`, `transcripts` and `search_transcripts`. Built-in Claude Code tools are off, the same as for the other agents. The run has at most six turns.

**Model and prompt.** The model is `AGENTS_MODEL` (default `claude-sonnet-5-5`). The prompt is `server/src/agents/prompts/earnings.md`. It asks for the same things as the other prompts: sources for each claim, "unknown" over a guess, no sizing, no orders, and calls only.

**Output.** An `EarningsReview`:

- `adjustment`: an integer from −15 to +15, added to the base score.
- `newsFactors`: each with a factor name, a direction (`+` or `-`) and evidence. Evidence is a claim, a source (the tool and section) and an as-of date.
- `verdict`: `act`, `wait` or `pass`.
- `entryConditions`: a checklist for the tape at entry.
- `exitPlan`: the planned exit time, a premium stop, a premium profit-take and what to do if the stock loses its level.
- `risks` and `summary` (three sentences at most).

**Guardrails in code.** The model's output goes through `finalize`. The review is stored with `status: "error"` and a reason if any of these holds:

- The adjustment is outside ±15.
- The adjustment is not zero and no news factor carries evidence.
- The verdict is `act` and any gate in the setup failed.

An error review still records the base score, the verdict the model gave and the cost. Its `adjustedScore` is null. An `ok` review has `adjustedScore = clamp(baseScore + adjustment, 0, 100)`.

**Budget and queue.**

- Each review is capped at `EARNINGS_REVIEW_MAX_USD` (default $0.15). The runtime passes this as the run's maximum spend.
- Reviews draw on the daily budget `AGENTS_DAILY_BUDGET_USD` (default $5), shared with the other agents. Before noon ET, while the morning brief has not run, the earnings agent leaves the brief's $0.60 reserve alone.
- A request queues one item per (symbol, horizon, report date, New York day). A setup already queued, running or reviewed today is skipped.
- The worker runs the highest-score item first. It re-reads the setup when it runs, so the review uses current numbers. If the budget runs out, the item goes back to the queue.
- Items whose report date has passed are dropped. An item whose setup or agent call throws is marked done and not retried.
- Each run is recorded in the runtime's `agent_runs` table.

**Cost.** Expected cost is about $0.10 to $0.15 per name, based on the commander's estimate. Measured cost is not recorded in this document. Each run is capped at `EARNINGS_REVIEW_MAX_USD`, so the cap is the most one review can spend. The queue estimate uses the cap, so it is an upper bound.

## Earnings tab

The Earnings tab is in the Ideas widget. It has its own filters, saved in the browser's local storage. The tab has no order buttons.

- **Filters.** A date range (default: the next weekday), a horizon selector (Report day, Week ahead, Month ahead), report time, sector, cap range in billions, minimum score, verdict and "tradable only". The horizon selector moves the date range to match, unless you have typed your own range.
- **Table.** Every match, 100 rows at a time, with "Show more" below. Columns: symbol, name, sector, cap, time, score, verdict, contract and spread, implied move, last surprise (EPS against the estimate) and last reaction. Each column header sorts.
- **Row expansion.** The five components with their reasons, the gates, the own and pooled stats (stock and call distributions), the last eight events and the analyst actions from the last 30 days. Each row has a **Review** button, which posts that one symbol to `POST /review`.
- **Review all shown.** Asks to confirm first. The estimate is the number of shown names that pass the gates times $0.15. Confirmation posts the current filter to `POST /review`. The tab sends the "tradable" filter only when its box is ticked. When it is not ticked, the server applies its gates-passed default, so only passing names are queued either way.
- **Reviews.** The latest review of each name is shown under its row.
- **Blocked states.** The review buttons are disabled with a tooltip when agents are off or the daily budget is spent.

The Calendar widget has a separate earnings list, not this tab.

## Limitations

- **Option history starts around February 2024.** Events before then have stock paths and event statistics, but no option paths. The option-based stats (call returns, IV ramp, the option legs in a setup's history) cover only the events since then.
- **Historical option prices are last trades, not quotes.** A contract that did not trade at a moment has no price there. Gaps are common in thin strikes, and a leg with no price at entry is not stored. Snapshots add quotes for the event expiry after each report, from the time the job started. Until enough snapshots have built up, the quote-based numbers are thin.
- **Small samples are blended with peers, not used alone.** A name with a few past events gets most of its history from the pool. The pool is the sector and cap bucket, or the cap bucket alone, when there are at least 20 events. The blend weight is `k = 5`. The score says how many events each number came from, so check `n` before you rely on a median.
- **Screens use stored snapshots only.** A name with no snapshot in the last four days shows `no_options`. The single-name route can ask Alpaca live, but the screen does not.
- **Snapshots exist only from the day the job started.** The store has no live quotes from before then.
- **FMP's dates can be wrong.** The checks catch most shifts, but the correction rules are heuristics. A date with `reason = "unconfirmed"` is kept in the store and excluded from stats. Unconfirmed events are not corrected.
- **Time unknown means no setup.** Events with no report time have no T0 or R, so they do not feed stats. A name whose upcoming report has no time fails the `unconfirmed_time` gate.
- **Weights are judgement.** The maxima and the points were set by hand and have not been fitted to outcomes. The history of setups is short. Change them only through `weights.ts`, and bump the version string when you do.
- **The review agent is an opinion with citations.** It can be wrong about news and about the tape. The code limits what it can change. It cannot change a number, and an adjustment with no evidence is rejected.
- **No orders.** Nothing here places, sizes or manages a position. The entry and exit times are for your own use.
