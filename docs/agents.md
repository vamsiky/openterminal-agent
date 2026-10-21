# Analysis agents

The agents read what the terminal already knows about an idea, weigh the case for and against it, and write a thesis: a verdict, a plan and the evidence behind them. They also write a daily pre-market brief and a macro report.

**Agents never place orders and never size positions.** Their output is advice for you to act on, in the web app only. Puts are only sold, never bought. The agents never propose buying puts, spreads or naked calls. The strategies they cover are:

| Strategy | What it means |
| --- | --- |
| Buy (stock) | Buy shares to hold for months |
| Buy call | Buy a call on a stock |
| Sell cash-secured put | Sell a put, with the cash to buy the shares if assigned |
| Sell covered call | Sell a call against at least 100 shares you already own |

Contents: [What each agent does](#what-each-agent-does) · [Schedule](#schedule) · [Queue and triggers](#queue-and-triggers) · [Budget and costs](#budget-and-costs) · [Authentication and billing](#authentication-and-billing) · [The guardrail](#the-guardrail) · [Thesis fields](#thesis-fields) · [API](#api) · [Settings](#settings) · [Tuning the prompts](#tuning-the-prompts) · [Limitations](#limitations)

Related: [scan engine](scan-engine.md) (the ideas and scorecards the agents start from) and [research API](research-api.md) (the data they read).

## What each agent does

Each agent runs as a Claude Agent SDK query from the server. Its only tools are the terminal's read-only MCP tools, named `mcp__openterminal__*`. Built-in Claude Code tools are off, so an agent cannot read files, run shell commands or browse the web. Each agent is allowed only the tools in its own row below.

| Agent | Model | Tools | Output |
| --- | --- | --- | --- |
| `macro` | Sonnet | `macro`, `economic_calendar`, `market_news`, `quote`, `market` | A macro report: regime flags, a short summary, today's events and risks |
| `bull` | Sonnet | `research_summary`, `fundamentals`, `ownership`, `transcripts`, `search_transcripts`, `content`, `quote`, `price_history`, `earnings_calendar`, `estimate_revisions`, `scorecard`, `option_metrics`, `market_news` | The best case for the idea, with cited evidence |
| `bear` | Sonnet | The same tools as `bull` | The best case against the idea, with cited evidence |
| `judge` | Opus | `quote`, `option_metrics` | The thesis: verdict, confidence, plan and catalysts |
| `brief` | Sonnet | None. It works only from inputs the code gathers. | The day's brief in markdown |

`bull` and `bear` run at the same time, and each argues only its own side. `judge` reads the idea, the scorecards, the macro report and both cases, weighs them, and writes the thesis. The judge has very few tools of its own because it works mostly from what it is given.

Every prompt tells its agent to:

- respect the user's horizons and the allowed strategies,
- cite every factual claim with the tool and the as-of date, such as `fundamentals:estimates`,
- say "unknown" instead of guessing,
- never invent numbers,
- never size positions and never place orders.

Each agent's output is requested as structured JSON against a schema and checked again with zod when it returns. An output that fails the check is stored as a run with status `error`.

## Schedule

All times are New York time. Schedules run on trading days only.

| Time | Job | Notes |
| --- | --- | --- |
| 06:30 | Macro report, `pre` | Before the open. Reserves budget for the day. |
| 06:40 | Analysis of stock ideas from the 16:30 screen | Only if they were not analysed that evening. |
| 07:00 | Brief | Waits up to 10 minutes for queued analyses to finish first. Reserves budget for the day. |
| 16:20 | Macro report, `post` | After the close. |
| Evening | Analysis of stock ideas from the 16:30 screen | Queued by the screen. |
| During the session | Analysis of option ideas | Queued as each option scan produces them. |

The stock screens run at 07:00 and 16:30, and the option scans every 5 minutes (see [scan engine: schedule](scan-engine.md#schedule)).

You can also run the macro report or the brief on demand: `POST /api/agents/run/macro` and `POST /api/agents/run/brief`. These are marked `adhoc` or run immediately.

## Queue and triggers

Analyses wait in a queue. The queue survives a restart because it is stored in the `agent_queue` table.

**What gets queued.** After each ideas screen and each option scan, the agents look at the active ideas and queue each one that:

- has no thesis for the same symbol, strategy and contract in the last 7 days (stock ideas), or on the same trading day (option ideas), or
- has a score that moved 10 points or more since its last thesis.

Each item is deduplicated by symbol, strategy, contract and day.

**Order.** Held symbols come first, then the rest by idea rank.

**Concurrency.** At most `AGENTS_CONCURRENCY` analyses run at once (default 2).

**Manual analysis.** `POST /api/agents/analyze` queues one analysis for a symbol and strategy, whether or not it is an idea. The web app's Analyse button uses it.

An analysis is: bull and bear together, then the judge, then a thesis row linked to the idea, with the total cost recorded.

## Budget and costs

The daily budget is `AGENTS_DAILY_BUDGET_USD` (default **$5**). It is enforced in the code. The day is the New York trading day.

**Per-run caps** limit what one run may spend:

| Run | Cap (USD) |
| --- | --- |
| Macro report | 0.30 |
| Bull case | 0.25 |
| Bear case | 0.25 |
| Judge | 0.40 |
| Brief | 0.15 |

A full stock or option analysis is bull plus bear plus judge, so at most $0.90. With the default budget, that is about five full analyses a day if nothing else runs.

Each run has a turn limit as well: 12 turns for the tool agents, and 3 for the judge and the brief.

**How the cap behaves.**

- Before a run starts, the code adds its cap to what has been spent today. If the total would be over the daily budget, the run is refused. It is recorded with status `skipped` and reason `budget_exhausted`, and counted in `skippedForBudget`.
- A refused analysis waits in the queue for the next trading day.
- The macro report at 06:30 and the brief at 07:00 keep $0.60 of the budget back. Analyses can only use what is left after that reserve.
- A single run can slightly overshoot its own cap. The run is stopped at its cap, but the cost reported when it finishes can be a little higher. Because the check adds the full cap before a run starts, the daily total stays within the budget apart from that small overshoot, and no new run starts once the budget is spent.

Every run records its cost, token use and duration in `agent_runs`. The web app footer shows the day's spend against the budget, for example `AI today $1.84 / $5.00 · 3 queued`.

## Authentication and billing

The agents use the Claude Agent SDK. How it is paid for depends on how it is authenticated:

- **With `ANTHROPIC_API_KEY` set,** runs are billed to that API account. The costs shown in the app are real charges.
- **Without it,** the Agent SDK uses the Claude account you are logged in with on this machine. The costs shown are notional. They are estimates of what the runs would cost on the API, and they are not billed to you as API usage.

Keep the key in `.env`, which is gitignored. The app never prints it.

## The guardrail

The code checks every thesis, not the model. A thesis that says `act` must have both of these:

1. an invalidation, either a price or a thesis condition, and
2. at least one catalyst with a date.

If either is missing, the thesis is stored with status `rejected`, and `statusReason` says which one was missing. The web app shows a rejected thesis dimmed, with that reason. A `wait` or `pass` verdict is not held to this rule.

## Thesis fields

Each thesis is stored in `theses` and returned as a `Thesis` object.

| Field | Meaning |
| --- | --- |
| `id`, `ideaId` | The thesis row, and the idea it was written for |
| `symbol`, `kind`, `strategy`, `contract` | What the thesis is about. `kind` is `stock` or `option`. |
| `asOf` | When the analysis ran |
| `status` | `ok`, `rejected` (guardrail) or `error` (a run failed) |
| `statusReason` | Why the thesis was rejected or failed |
| `verdict` | `act`, `wait` or `pass` |
| `confidence` | 0 to 100 |
| `horizon` | For example `3–6 months` or `1–5 days` |
| `entry` | A price zone with a note, or `null` |
| `target` | A price with a note, or `null` |
| `invalidation` | A price or a condition, or `null` |
| `exitPlan` | For options: profit-take, stop and roll rules. For stock: trim and exit rules. |
| `catalysts` | Events with dates. A date may be `null`. |
| `risks` | Risks in words |
| `summary` | The judge's reasoning in a few sentences |
| `bull`, `bear` | The two cases, each with points and evidence |
| `evidence` | Each claim with its source and as-of date, such as `fundamentals:estimates` |
| `inputs` | The scorecard and macro report the analysis used |
| `models` | The model each agent ran on |
| `costUsd` | What the analysis cost |

The judge's strategy rules are in its prompt:

- **Buy (stock).** An entry zone, a 6 to 12 month target, an invalidation as a price or a thesis condition, and catalysts with dates.
- **Buy call.** Whether to buy the streamed contract now or wait for a pullback. The judge respects the stretch guard: a "stretched" reason means wait. It also sets a premium profit-take and stop, a time stop before expiry, and what to do about earnings before expiry.
- **Sell cash-secured put.** Only if you would be happy to own the shares at the strike. It sets an assignment plan, an early-close level for the premium, and a roll rule. It also flags earnings and ex-dividend dates before expiry.
- **Sell covered call.** Only against shares you hold. It says what happens if the shares are called away, notes early-assignment risk before an ex-dividend date, and sets a roll rule.

## API

All routes are under `/api/agents` and need the `x-api-key` header. When `AGENTS_ENABLED=0`, the analyse and run routes return 503.

| Route | Returns |
| --- | --- |
| `GET /api/agents/status` | Status: whether agents are enabled, today's spend and budget, the queue, what is running, the latest macro report and brief |
| `GET /api/agents/macro/latest` | The latest macro report, or 404 |
| `GET /api/agents/macro?limit=` | Recent macro reports, newest first |
| `GET /api/agents/theses?symbol=&strategy=&limit=` | Theses, newest first |
| `GET /api/agents/theses/:id` | One thesis |
| `GET /api/agents/theses/latest?ideaId=` | The latest thesis for an idea, or 404 |
| `GET /api/agents/theses/latest?symbol=&strategy=&contract=` | The latest thesis for a symbol, strategy and contract, or 404 |
| `POST /api/agents/analyze` | Queues an analysis (see below) |
| `POST /api/agents/run/:agent` | Runs `macro` or `brief` now |
| `GET /api/agents/brief/latest` | The latest brief, or 404 |
| `GET /api/agents/briefs?limit=` | Recent briefs, newest first |
| `GET /api/agents/runs?limit=` | Recent runs: agent, symbol, model, status, cost, tokens, duration, error |

`POST /api/agents/analyze` takes:

```json
{ "symbol": "NVDA", "strategy": "short_put", "contract": "NVDA261218P00170000", "ideaId": 41 }
```

`contract` and `ideaId` are optional. It returns:

| Status | Meaning |
| --- | --- |
| `202` | Queued: `{ "queued": true, "position": 2 }` |
| `409` | The analysis is already queued or running |
| `402` | `{ "error": "daily AI budget reached" }` |
| `503` | Agents are disabled |

`POST /api/agents/run/:agent` (for `macro` or `brief`) returns `202`, `409` when that run is already going, `402` when the budget is spent, and `503` when agents are disabled.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | none | Turns on billing to your API account. Without it, the Agent SDK uses your logged-in Claude account and costs are notional. |
| `AGENTS_ENABLED` | `1` | `0` turns off the schedules and the analyse and run routes. |
| `AGENTS_DAILY_BUDGET_USD` | `5` | The most the agents may spend in one trading day. |
| `AGENTS_CONCURRENCY` | `2` | Analyses that run at once. |
| `AGENTS_MODEL` | `claude-sonnet-5-5` | Model for the macro, bull, bear and brief agents. |
| `AGENTS_JUDGE_MODEL` | `claude-opus-5-5` | Model for the judge. |

The MCP server the agents call uses `API_PORT` and the app key, set by the server itself.

## Tuning the prompts

Each agent's instructions are in its own file, `server/src/agents/prompts/*.md`: `macro.md`, `bull.md`, `bear.md`, `judge.md` and `brief.md`. The files are plain markdown, and you can edit them to change how an agent reasons, what it emphasises or how it writes.

Keep these rules in any edit:

- puts are only sold,
- every claim needs a cited tool and as-of date,
- say "unknown" rather than guess,
- no position sizing and no orders.

The output schema is set in code, so changing a prompt cannot change the fields a thesis has. If you add a field to a prompt, the code must accept it too.

## Limitations

- Agents read data through the same tools you have. They are only as good as those tools and the data behind them, which the [research API](research-api.md) describes.
- A verdict is a judgement on the data at the time of the run. It is not refreshed until the next analysis, and it is not monitored.
- The guardrail checks that an invalidation and a dated catalyst exist. It does not check that they are sensible.
- Costs shown without `ANTHROPIC_API_KEY` are estimates, not charges.
- A run can overshoot its own cap by a small amount, so the daily total can sit a little above the budget. No run starts once the budget is spent.
- The agents do not place orders, size positions or manage risk. Risk rules and position sizing are not part of this phase.
