# Analysis agents

The agents read what the terminal already knows about an idea, weigh the case for and against it, and write a thesis: a verdict, a plan and the evidence behind it. They also write a macro report each morning and evening and a pre-market brief.

**Agents never place orders and never size positions.** Their output is advice for you to act on, in the web app only. **Puts are only sold, never bought.** The agents never propose buying puts, spreads, straddles or naked calls. The strategies they cover are:

| Strategy | What it means |
| --- | --- |
| Buy (stock) | Buy shares to hold for 6 to 12 months |
| Buy call | Buy a short-dated call, for an intraday-to-swing momentum trade |
| Sell cash-secured put | Sell a put, with the cash to buy the shares if assigned. Only on stocks you would be happy to own at the strike. |
| Sell covered call | Sell a call against at least 100 shares you already own |

Contents: [What each agent does](#what-each-agent-does) · [Schedule](#schedule) · [Queue and triggers](#queue-and-triggers) · [Budget and costs](#budget-and-costs) · [Authentication and billing](#authentication-and-billing) · [The guardrail](#the-guardrail) · [Thesis fields](#thesis-fields) · [Price warnings](#price-warnings) · [API](#api) · [Settings](#settings) · [Tuning the prompts](#tuning-the-prompts) · [Limitations](#limitations)

Related: [scan engine](scan-engine.md) (the ideas and scorecards the agents start from), [research API](research-api.md) (the data they read) and [options data](options-data.md) (the option quotes and metrics).

## What each agent does

Each agent runs as a Claude Agent SDK query from the server. Its only tools are the terminal's read-only MCP tools, named `mcp__openterminal__*`. Built-in Claude Code tools are off, so an agent cannot read files, run shell commands or browse the web. Settings from your Claude Code installation and any `CLAUDE.md` file are not loaded. Each agent is allowed only the tools in its row below.

| Agent | Model | Tools | Output |
| --- | --- | --- | --- |
| `macro` | Sonnet | `macro`, `economic_calendar`, `market_news`, `quote`, `market` | A macro report: five regime flags, a summary, the day's events and the risks |
| `bull` | Sonnet | `research_summary`, `fundamentals`, `ownership`, `transcripts`, `search_transcripts`, `content`, `quote`, `price_history`, `earnings_calendar`, `estimate_revisions`, `scorecard`, `option_metrics`, `market_news` | The best case for the idea, with cited evidence |
| `bear` | Sonnet | The same tools as `bull` | The best case against the idea, with cited evidence |
| `judge` | Opus | `quote`, `option_metrics` | The thesis: verdict, confidence, plan, catalysts and summary |
| `brief` | Sonnet | None. It works only from inputs the code gathers. | The day's brief in markdown |

`bull` and `bear` run at the same time, and each argues only its own side. `judge` then reads the idea, the scorecards, the macro report and both cases, and writes the thesis. The judge's input is built by code. It holds the facts the code gathers, the current quote, the option mid when the contract is streamed, the held position, the next earnings and ex-dividend dates, and both cases. The judge has only two tools, and it works mostly from that input.

**Ground rules every agent follows** (from the shared prompt, `common.md`):

- Use the tools to read data. Do not use outside knowledge for prices, numbers, dates or events.
- Cite every factual claim with its source, as the tool and section, for example `fundamentals:estimates` or `quote`, and the as-of date of the data.
- Every number must come from a tool result or from the facts in the task. A number the agent works out itself must show its calculation, for example `about $1,010 (= price $919 / (1 - 0.09))`. Otherwise the number is left out.
- If something is not in the data, the agent says "unknown". It does not guess.
- Data older than a few days is flagged as stale.
- Keep tool use efficient: a handful of calls, not dozens.

Each agent's output is requested as structured JSON against a schema and checked again with zod when it returns. An output that fails the check is retried once. If the retry also fails, the run is stored with status `error`.

## Schedule

All times are New York time. Schedules run on trading days only, using the Alpaca trading calendar.

| Time | Job | Notes |
| --- | --- | --- |
| 06:30 | Macro report, `pre` | Retried until 12:00 if it fails, up to three failures a day. |
| 06:40 to 09:30 | Stock analyses | The pre-market window. Catches stock ideas left over from the evening. |
| 07:00 | Brief | Once a day. Waits up to 10 minutes (until 07:10) for stock analyses still running. |
| 16:20 | Macro report, `post` | Retried under the same rules as the pre-market report. |
| 16:35 onward | Stock analyses | The evening window, after the 16:30 stock screen. |
| Any time | Option analyses | Run as soon as queued, as each option scan produces ideas. |

The stock screens run at 07:00 and 16:30, and the option scans every 5 minutes in the session (see [scan engine: schedule](scan-engine.md#schedule)).

You can also run the macro report or the brief on demand: `POST /api/agents/run/macro` and `POST /api/agents/run/brief`. Manual requests run at once, outside the windows above.

## Queue and triggers

Analyses wait in a queue, stored in the `agent_queue` table. The queue survives a restart.

**What gets queued.** Ideas are queued by two triggers:

- a **hook** that runs after each stock screen and each option scan, so new ideas are queued at once, and
- a **poll** of the ideas table every minute.

An active idea is queued when either of these is true:

- **Stocks:** it has no usable thesis for the same symbol and strategy in the last 7 days.
- **Options:** it has no thesis for the same symbol and strategy today (the same trading day).
- Either way, its score has moved 10 points or more since its last thesis.

A thesis that failed does not count. That idea is queued again the next day.

**Dedupe.** Each item is deduplicated per day:

- **Stock items:** by symbol, strategy and day.
- **Automatic option items:** by symbol, strategy and day. The contract is not part of the key, because the idea's contract moves as the price moves. The thesis still records the contract it analysed.
- **Manual option items:** by symbol, strategy, contract and day.

**Order.** Manual requests go first, then held symbols, then idea rank.

**Concurrency.** At most `AGENTS_CONCURRENCY` analyses run at once (default 2).

**Stale items.** A queued automatic item older than three days is dropped. Its idea has moved on.

**Manual analysis.** `POST /api/agents/analyze` queues one analysis for a symbol, strategy and contract. It does not wait for an idea to appear. The web app's Analyse button uses it.

- If the same item is already queued, the request moves it to the front of the queue and returns its new position. It does not add a second copy.
- It returns 409 only when that exact item is running right now.
- Manual requests ignore the stock windows above.

An analysis is: bull and bear together, then the judge, then one thesis row linked to the idea, with the total cost recorded.

## Budget and costs

The daily budget is `AGENTS_DAILY_BUDGET_USD` (default **$5**). It is enforced in code. The day is the New York trading day.

**Per-run caps** limit what one run may spend:

| Run | Cap (USD) | Setting |
| --- | --- | --- |
| Macro report | 0.30 | `AGENTS_CAP_MACRO_USD` |
| Bull case | 0.25 | `AGENTS_CAP_BULL_USD` |
| Bear case | 0.25 | `AGENTS_CAP_BEAR_USD` |
| Judge | 0.40 | `AGENTS_CAP_JUDGE_USD` |
| Brief | 0.15 | `AGENTS_CAP_BRIEF_USD` |

A full stock or option analysis is bull plus bear plus judge, so at most $0.90 under the default caps. Turn limits are also set per agent: 12 turns for the tool agents, and 3 for the judge and the brief.

**How the cap behaves.**

- Before a run starts, its cap is added to what has been spent today. If the total would be over the daily budget, the run is refused. It is recorded with status `skipped` and error `budget_exhausted`, and counted as skipped for the day.
- An analysis that is refused waits in the queue for the next trading day.
- A **$0.60 reserve** is held back from analyses until the day's brief has run or been skipped, and never past 12:00 ET. The macro reports and the brief can use it. The post-close macro report is not reserved.
- A run is stopped at its cap. The cost reported when it finishes can be a little higher than the cap, so a single run can overshoot slightly. No new run starts once the budget is spent.
- Each run has a 10-minute timeout. A run that times out is an error.

Every run records its cost, token use, duration and authentication in `agent_runs`. The web app footer shows the day's spend against the budget, for example `AI today $1.84 / $5.00 · 3 queued · 1 running (Claude login)`.

## Authentication and billing

The agents use the Claude Agent SDK. How runs are paid for depends on how the SDK is authenticated, which the status reports as `auth`:

- **`api_key`:** `ANTHROPIC_API_KEY` is set. Runs are billed to that API account, and the costs shown in the app are real charges.
- **`claude_login`:** no key is set. The SDK uses the Claude account you are logged in with on this machine. The costs shown are **notional**: they are estimates of what the runs would cost on the API. They are not billed to you as API usage.

Keep the key in `.env`, which is gitignored. The app never prints it.

## The guardrail

The code checks every thesis, not the model. The rules apply to a verdict of `act` only. A `wait` or `pass` is never rejected.

An `act` is rejected, and stored with status `rejected`, when any of these is true:

1. it has no invalidation, meaning neither a price nor a condition;
2. it has no catalyst with a date on or after the thesis day. A catalyst with no date does not count;
3. it is a covered call and you hold fewer than 100 shares.

`statusReason` says which rule was broken. The web app shows a rejected thesis dimmed, with that reason.

## Thesis fields

Each thesis is stored in `theses` and returned as a `Thesis` object.

| Field | Meaning |
| --- | --- |
| `id`, `ideaId` | The thesis row, and the idea it was written for |
| `symbol`, `kind`, `strategy`, `contract` | What the thesis is about. `kind` is `stock` or `option`. |
| `asOf` | When the analysis ran |
| `status` | `ok`, `rejected` (guardrail) or `error` (a run failed) |
| `statusReason` | Why the thesis was rejected or failed, plus any price warning. Warnings never change `status`. |
| `verdict` | `act`, `wait` or `pass` |
| `confidence` | 0 to 100 |
| `horizon` | For example `3-6 months` or `1-5 days` |
| `entry` | A price zone with a note, or `null` |
| `target` | A price with a note, or `null` |
| `invalidation` | A price or a condition, or `null` |
| `exitPlan` | For options: profit-take, stop and roll rules. For stock: trim and exit rules. |
| `catalysts` | Events with dates. A date may be `null` when the event is truly undated. |
| `risks` | Risks in words |
| `summary` | The judge's reasoning in a few sentences |
| `bull`, `bear` | The two cases, each with points and evidence |
| `evidence` | Each decisive claim with its source and as-of date |
| `inputs` | The scorecard dates, the macro report and the idea score the analysis used |
| `models` | The model each agent ran on |
| `costUsd` | What the analysis cost |

**Units.** The judge must keep the two units apart:

- **Stock theses** (`buy`): `entry`, `target` and `invalidation` are all underlying stock prices.
- **Option theses** (`long_call`, `short_put`, `covered_call`): `entry` and `target` are the **option premium per share**, which is what you would pay or receive, and the premium at which to take profit. The task gives the contract's current mid when it is streamed. `invalidation.price` is always an **underlying stock price**.

The judge's strategy rules are in its prompt:

- **Buy (stock).** An entry zone, a 6 to 12 month target, an invalidation as a price or a thesis condition, catalysts with dates, and trim and exit rules.
- **Buy call.** Whether to buy the streamed contract now or wait for a pullback. A "stretched" reason in the idea means prefer `wait`. The judge also sets a premium profit-take and a premium stop, a time stop before expiry, and a rule for an earnings date before expiry, which usually means avoid or exit before it.
- **Sell cash-secured put.** Act only if you would be happy to own the shares at the strike. The judge gives the assignment plan, an early-close level (for example, buy back after 50 to 70% of the premium is captured), a roll rule, and flags any earnings or ex-dividend date before expiry.
- **Sell covered call.** Act only against shares you hold. With fewer than 100 shares, the verdict is `pass`. The judge says what happens if the shares are called away, the early-assignment risk before an ex-dividend date, and a roll up-and-out rule.

## Price warnings

After the guardrail, the code checks the judge's prices against the current price. A price that is far from it adds a warning to `statusReason`, as `warning: far from the current price: …`. The warning never changes `status`, and it never rejects the thesis. The check is skipped when there is no quote.

| Thesis | Checked against | Warns when |
| --- | --- | --- |
| Stock: entry, target, invalidation | The underlying price | More than 50% away |
| Option: entry | The contract's mid | More than 50% away |
| Option: target | The contract's mid | Above 5 times the mid, or below 0.05 times it. Profit-takes sit far from the mid by design, so the band is wide. |
| Option: invalidation | The underlying price | More than 50% away |

## API

All routes are under `/api/agents` and need the `x-api-key` header. The POST routes answer right away and do their work in the background. When `AGENTS_ENABLED=0`, the analyse and run routes return 503.

| Route | Returns |
| --- | --- |
| `GET /api/agents/status` | Whether agents are enabled; today's spend, budget, runs and skips; the queue; what is running; the latest macro report and brief; `auth` and `availableUsd` (see below) |
| `GET /api/agents/macro/latest` | The latest macro report, or 404 |
| `GET /api/agents/macro?limit=` | Recent macro reports, newest first |
| `GET /api/agents/theses?symbol=&strategy=&limit=` | Theses, newest first |
| `GET /api/agents/theses/:id` | One thesis, or 404 |
| `GET /api/agents/theses/latest?ideaId=` | The latest thesis for an idea, or 404 |
| `GET /api/agents/theses/latest?symbol=&strategy=&contract=` | The latest thesis for a symbol, strategy and contract, or 404. Use `ideaId`, or `symbol` and `strategy`. |
| `POST /api/agents/analyze` | Queues an analysis (below) |
| `POST /api/agents/run/:agent` | Starts a `macro` or `brief` run now |
| `GET /api/agents/brief/latest` | The latest brief, or 404 |
| `GET /api/agents/briefs?limit=` | Recent briefs, newest first |
| `GET /api/agents/runs?limit=` | Recent runs: agent, symbol, model, status, cost, tokens, duration, authentication, error |

### `GET /api/agents/status`

- `auth` is `api_key` or `claude_login`, taken from the latest run. It is `null` until a run has happened.
- `availableUsd` is what a macro run could still spend today: the daily budget less today's spend. Analyses see less, because of the brief reserve.

### `POST /api/agents/analyze`

```json
{ "symbol": "NVDA", "strategy": "short_put", "contract": "NVDA261218P00170000", "ideaId": 41 }
```

`contract` and `ideaId` are optional. The response:

| Status | Meaning |
| --- | --- |
| `202` | Queued, or promoted to the front: `{ "queued": true, "position": 1 }` |
| `409` | That exact item is running right now |
| `402` | `{ "error": "daily AI budget reached" }` |
| `503` | Agents are disabled |

### `POST /api/agents/run/:agent`

`:agent` is `macro` or `brief`. Any other name returns 404.

| Status | Meaning |
| --- | --- |
| `202` | Started: `{ "started": true, "agent": "brief" }` |
| `409` | That run is already going |
| `402` | Budget spent |
| `503` | Agents are disabled |

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | none | Bills runs to your API account. Without it, the agents use your logged-in Claude account and costs are notional. |
| `AGENTS_ENABLED` | `1` | `0` turns off the schedules and the analyse and run routes. |
| `AGENTS_DAILY_BUDGET_USD` | `5` | The most the agents may spend in one trading day. |
| `AGENTS_CONCURRENCY` | `2` | Analyses that run at once. |
| `AGENTS_MODEL` | `claude-sonnet-5-5` | Model for the macro, bull, bear and brief agents. |
| `AGENTS_JUDGE_MODEL` | `claude-opus-5-5` | Model for the judge. |
| `AGENTS_CAP_MACRO_USD` | `0.30` | Cap for one macro run. |
| `AGENTS_CAP_BULL_USD` | `0.25` | Cap for one bull case. |
| `AGENTS_CAP_BEAR_USD` | `0.25` | Cap for one bear case. |
| `AGENTS_CAP_JUDGE_USD` | `0.40` | Cap for one judge run. |
| `AGENTS_CAP_BRIEF_USD` | `0.15` | Cap for one brief. |

The MCP server the agents call is started by the server, with the app's port and key. Nothing else needs setting.

**First start.** When the server starts with agents enabled, every idea without a thesis is queued at once. Option ideas run immediately, at about $0.30 each in practice. That is an estimate, not a cap: each analysis is capped at $0.90. On a Claude login the cost is notional. Stock ideas wait for their window.

## Tuning the prompts

Each agent's instructions are in `server/src/agents/prompts/`:

- `common.md`: the ground rules, shared by every agent.
- `macro.md`, `bull.md`, `bear.md`, `judge.md` and `brief.md`: one file per agent.

The prompt for an agent is `common.md` followed by its own file. **The prompts are re-read on every run,** so an edit takes effect on the next run, with no restart. The build copies the prompts to `dist`, so the built server has them too.

Keep these rules in any edit:

- puts are only sold,
- every claim needs a cited tool and as-of date,
- say "unknown" rather than guess,
- derived numbers must show their calculation,
- no position sizing and no orders.

The output schema is set in code, not in the prompts. Changing a prompt cannot add or remove a thesis field. A new field needs a code change as well.

## Limitations

- **Verdicts lean to `wait`.** The judge is asked to prefer `wait` with a note saying what would change its mind, over a number it cannot support. A thesis with no numbers is common, and it is intended.
- **Brief movers need the live feed.** The "Overnight and pre-market" section lists the biggest moves from the extended-hours fields of live quotes. Without the live feed, that section is empty.
- **Costs are notional on a Claude login.** Without `ANTHROPIC_API_KEY`, the costs shown are estimates. Nothing is billed to you as API usage.
- **Prompts are re-read each run.** An edit takes effect on the next run, which is convenient. It also means a bad edit affects the next run at once. Keep a copy of a working prompt.
- The guardrail checks that an invalidation and a dated catalyst exist. It does not judge whether they make sense.
- Agents read data through the same tools you have. They are only as good as those tools and the data behind them.
- A verdict is a judgement on the data at the time of the run. It is not refreshed until the next analysis, and it is not monitored.
- The agents do not place orders, size positions or manage risk. Risk rules and position sizing are not part of this phase.
