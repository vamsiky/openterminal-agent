# Scan Lab

Scan Lab is where you change the rules the scans use. The scans score every option setup and every stock on a schedule. The rules that decide what counts as an idea live in a versioned **scan definition**, not in code. You can read the rules as plain text, change them in words, test a change on stored data, and then make it live.

**Scan Lab never places orders, and it never edits code.** A definition can only change settings the scans already use. Claude builds drafts from your text. You decide when a draft goes live.

Contents: [What Scan Lab is](#what-scan-lab-is) · [How a scan is defined](#how-a-scan-is-defined) · [The text view](#the-text-view) · [Building a draft with Claude](#building-a-draft-with-claude) · [The Settings form](#the-settings-form) · [Testing](#testing) · [Promote, roll back and discard](#promote-roll-back-and-discard) · [Near misses](#near-misses) · [API](#api) · [Limits](#limits)

Related: [scan engine](scan-engine.md) (the universe, the scorecards, the schedule and the ideas) and [analysis agents](agents.md) (the daily budget that Scan Lab shares).

## What Scan Lab is

Scan Lab has two definitions, one for options and one for stocks. Each one is the full set of rules for one scan:

- **Option definition.** The listing bar, the idea limits, and three fixed strategies: buy a call, sell a cash-secured put, and sell a covered call. Each strategy has its gates, its scoring terms and its penalties.
- **Stock definition.** The factors, their directions and groups, the group weights, the filters, and the list size.

The scans run the **active** definition. Ideas always come from the active definition. A draft is never used for ideas. You can test a draft before you promote it.

The Scan Lab widget has two kinds, Option and Stock. Each kind has its own versions, drafts and tests.

## How a scan is defined

### Versions and statuses

A definition is a versioned JSON document. The first two are built in and start as active on the first run:

- `option-v1`, the option rules the scan used before definitions existed.
- `stock-v2`, the stock rules.

Every change makes a new version name, such as `option-v2` or `stock-v3`. A version is never edited in place. Each version records its parent, so the diff against the version it came from is always there.

Each version has one status:

| Status | Meaning |
| --- | --- |
| `active` | The version the scans run now. One per kind. |
| `draft` | A change under test. One per kind. A new draft replaces the open one, which becomes `discarded`. |
| `previous` | The version active before the last promote. One per kind. You can roll back to it. |
| `retired` | An older version. It cannot be made active again. |
| `discarded` | A draft that was thrown away or replaced. |

Only one draft can be open for each kind. Promote moves the draft to `active` and the old active to `previous`. The old `previous` becomes `retired`.

### The definition

An option definition has four parts: `listing`, and `strategies` with exactly three keys, `long_call`, `short_put` and `covered_call`. A stock definition has `factors`, `liveFactors`, `groupWeights`, `minPeers`, `staleBarDays`, `filters` and `listing`. The schema rejects any other key. Each number has a minimum and a maximum.

The text view and the Settings form are two ways to read and change the same document. The JSON is the record.

### The data catalog

A condition or an expression can only use a **field** from the catalog. The catalog is the complete list of data the scans can see. Each field has:

- `key`, the name used in the definition, such as `iv_rank` or `m15`;
- `label`, the name shown to you;
- `unit`, which decides the bounds and whether the field can be used in arithmetic;
- `description` and `source`, which say what the number is and where it comes from;
- `group`, which sets where it sits in the list.

Units are `score_0_100`, `score_pm100`, `pct`, `ratio`, `x`, `usd`, `days`, `count`, `bool`, `date` and `text`. Numbers, percents, ratios, dollars, days, counts and booleans can be compared and added. Dates and text can only be used in sentences.

You can see the catalog for one scope with `GET /api/scan/catalog?scope=option` (or `stock`).

**Adding a field is a code change.** The catalog is the only way data enters a definition. A new field needs two things:

1. A catalog entry in `server/src/scandef/catalog.ts`, with its unit, description and source.
2. The scan that computes it must supply a value for each symbol.

To ask for one from Scan Lab, either:

- build a draft with text that needs the field. Claude marks that line `needs_code` and the request is stored; or
- post the request yourself with `POST /api/scan/code-requests`.

Requests are stored for the maintainer to read. Nothing acts on them automatically, and no route changes a request's status yet.

### Gates, terms and penalties

An option strategy scores in three parts. Each part is a list.

**Gates** decide whether a setup can score at all. A setup needs every gate to hold. A strategy has at most 10 gates. Each gate is a condition with a label.

```json
{
  "label": "Daily uptrend",
  "expr": "d1",
  "op": ">=",
  "value": 25,
  "say": "daily uptrend {d1:int} (at least {value})"
}
```

**Terms** add points to the score. The strategy starts at its `base` score. A term with a condition adds its points when the condition holds. A term with an expression adds its points times the expression's value, so a scaled expression (0 to 1) gives a share of its points. A term adds nothing when its data is missing. A strategy has at most 16 terms.

```json
{
  "label": "Momentum",
  "expr": { "scale": { "expr": { "avg": ["m15", "h1"] }, "from": 40, "to": 100 } },
  "points": 25
}
```

The scale takes an expression and maps it from `from` to `to` on a 0 to 1 range. Below `from` it gives 0. At or above `to` it gives 1. Here the term gives 0 points at a momentum of 40 and the full 25 at 100.

**Penalties** take points off the score when their condition holds. Points are entered as a positive number. A strategy has at most 12 penalties.

```json
{
  "label": "Earnings before expiry",
  "cond": { "expr": "earnings_before_expiry", "op": "==", "value": true },
  "points": 15,
  "say": "caution: earnings on {next_earnings} fall before the {atm_expiry} expiry"
}
```

A penalty can also count several signs. Each sign that holds costs `pointsEach`, up to `cap` in total.

**Expressions and conditions.** Expressions use fields, numbers, `avg`, `min`, `max`, `sum`, `diff`, `ratio`, `scale`, `if` and `coalesce`. Conditions compare an expression with a value (`>=`, `>`, `<=`, `<`, `==`, `!=`) or a range (`between`), or check that a field is `known`. Conditions can be combined with `all`, `any` and `not`. Nesting is at most 10 levels.

A field with no data is `null`. An expression that uses a `null` is `null`. A comparison on a `null` is false. A penalty or term on missing data adds nothing, and a gate on missing data fails.

**Sentences.** A `say` text is the reason line shown for a term, gate or penalty. A placeholder such as `{d1:int}` is replaced by the value. Each placeholder must name a catalog field, and a format must be one of the names the text view supports. A sentence can have variants: the first one whose `when` holds is used.

**Stock definitions** have no gates, terms or penalties. Each stock factor has an `include` switch, a `direction` (higher or lower is better), a `positiveOnly` switch (losses score worst), and a `rankAgainst` (the sector or the whole market). Filters are conditions a stock must pass to be listed.

## The text view

The Text tab shows the active definition as plain text. Claude writes it from the definition at read time, so it always matches what runs. The stored text is only a record of what was shown when the version was written.

To change the rules, edit the text and press **Build draft with Claude**. Edits live in your browser until you build, so they are lost on a reload. The draft is built from your text against the active version. If you edit the text after a build, the draft shows as out of date and cannot be promoted until you build again.

The golden texts for the two built-in versions are in `server/src/scandef/golden/option-v1.txt` and `stock-v2.txt`. Tests check that the rendered text matches them.

## Building a draft with Claude

### What happens

1. You edit the text and press **Build draft with Claude**.
2. The server works out which lines differ from the active version. Each changed line gets a number and its section heading.
3. Claude reads your text, the catalog and the definition schema. It returns the complete new definition and one outcome for each numbered line.
4. The server checks the result. It checks the schema, the catalog keys, the bounds and the fixed rules. It also checks the line outcomes (see below). If the check fails, Claude gets the errors and tries once more.
5. If the result passes, it is stored as a new draft. The draft records your text, Claude's notes, and the line outcomes.

A build runs in the background. Poll `GET /api/scan/defs/build/:jobId` until its status is `done` or `error`. On `done`, `draftId` is the new draft.

### Per-line outcomes

Each changed line gets exactly one outcome:

| Outcome | Meaning |
| --- | --- |
| `applied` | Claude changed the definition for this line. The definition must actually differ from the active version. |
| `needs_code` | The line asks for data or logic the catalog or the language cannot express. It is also added to the code requests. |
| `no_change` | The line only rewords what the definition already does. |
| `refused` | The line asks for something the fixed rules forbid. |

The server rejects a result that leaves a numbered line out, repeats one, or marks an unchanged definition as applied. A build that finds nothing to change ends in `error` with the message "Claude found nothing to change in your text."

### The fixed rules

The strategies are fixed. Scan Lab can tune them, but it cannot add to them.

- **Allowed:** buy calls (`long_call`), sell cash-secured puts (`short_put`), and sell covered calls (`covered_call`).
- **Never:** long puts, spreads, naked calls, or any order.

The schema allows only the three strategy keys, and each strategy has a fixed contract. A covered call must have a gate that requires 100 or more shares held.

Before the model runs, the server looks at lines you added or changed. If a line seems to ask for buying puts, spreads or multi-leg structures, naked calls, or placing orders, the prompt tells Claude to refuse it. A negated mention, such as "never buy puts", does not count. The refusal is a hint, not the only check. When Claude refuses, the job ends in `error` with `refused: true` and the reason in `error`.

### Limits on a build

- **One build per kind at a time.** A second build for the same kind returns `409` until the first one ends.
- **Jobs are kept in memory.** A restart loses them. The server keeps the 50 newest jobs.
- **Cost cap.** Each model call is capped at `AGENTS_CAP_SCANLAB_USD` (default `0.20`). A build makes one call, or two when the first result fails the checks.
- **Daily budget.** Before each call, the build checks the daily budget, `AGENTS_DAILY_BUDGET_USD` (default `5`). It is the same budget the analysis agents use. When it is spent, the build returns `402`.
- **Off switch.** `AGENTS_ENABLED=0` turns off builds. They return `503`.
- **Model.** `AGENTS_MODEL` (default `claude-sonnet-5-5`). Claude has no tools during a build.

## The Settings form

The Settings tab lists every number, switch and choice in the definition, grouped by section: Listing, one section per strategy, Weights, Scoring, Factors, Live factors and Filters. Each row shows the label, the value, its unit, and the range.

Each number has a range set by its unit:

| Unit | Min | Max | Step |
| --- | --- | --- | --- |
| `score_0_100` | 0 | 100 | 1 |
| `score_pm100` | -100 | 100 | 1 |
| `pct` | -5 | 5 | 0.01 (0.05 is 5%) |
| `ratio`, `x` | -20 | 20 | 0.1 |
| `usd` | 0 | 1,000,000 | 1 |
| `days` | 0 | 400 | 1 |
| `count` | 0 | 10,000 | 1 |
| `bool` | 0 | 1 | 1 |

Points are 0 to 100 for penalties and listing scores, and -100 to 100 for term points. The form and the validation use the same limits. A value out of range is refused with `400`.

**Hidden on purpose.** The form shows only values that a person should tune. It leaves out:

- literal numbers inside expressions, such as the 1 and 0 of an `if`;
- data guards, such as "is known" checks and the fallbacks for missing data;
- the rule itself when a condition is true or false;
- the word parts of a sentence.

**Read-only.** The contract of each strategy is set by the options sweep, so it cannot be changed here.

**Words are not in the form.** Labels and the reason sentences change only through the text view and Claude.

Each change saves as a new draft through `POST /api/scan/defs/draft`. A saved draft replaces the open draft. The **What changes** table under the form lists every setting that differs from the parent version.

## Testing

A draft can be tested in two ways. Both score the draft and the definition that ran the pass on the same inputs. Neither writes ideas.

### Replay

Replay scores stored inputs again. It uses the snapshots that the scans save for each pass:

- **What it replays.** The inputs of every stored pass, kept for the last **10 trading days**. The scans save an option input at each option pass and a stock input at each intraday stock pass.
- **The two sides.** The "live" side is the definition that scored that pass. The "draft" side is your draft on the same inputs.
- **What it writes.** A replay result for the draft. Nothing in the ideas list changes.
- **Source.** `latest` replays the newest stored pass. A pass time replays that one pass.

A draft must have at least one replay before it can be promoted.

### Live shadow

Live shadow runs the draft on each real pass as it happens:

- Turn it on with `POST /api/scan/defs/:id/shadow` and `{ "on": true }`.
- Each scheduled pass also scores the draft. The result is stored as a shadow pass.
- It **never writes ideas**, near misses or agent triggers. It only stores its own results.
- Shadow passes are kept for 10 trading days, like the inputs.
- One shadow can run for each kind. It stops when its draft is replaced, discarded, promoted or rolled back, or when you turn it off.

### Compare

Compare puts the live and draft results side by side. It is available for a replay or a shadow pass:

- **Ideas.** `added` lists ideas the draft would add. `removed` lists ideas it would drop. `rankChanges` lists ideas that stay but move up or down, with the old and new score.
- **Gates.** `funnel` lists each step in turn with the count that passes it. For an option strategy, the steps are the gates in order, then `Listed`. For a stock, the steps are the screen steps, such as coverage and each filter, then the list.
- **Spread.** `spread` counts the scores in buckets: under 50, then 50 to 55, 55 to 60, and so on up to 75 to 80, then 80 and up.

Use the shadow results to see how the draft behaves in the live market. Use the replay results to test a change against past passes.

## Promote, roll back and discard

- **Promote.** `POST /api/scan/defs/:id/promote`. The draft becomes `active`. The old active becomes `previous`, and the old `previous` is retired. Promote returns `409` unless the version is a draft with at least one replay. The Scan Lab button is also off when the draft is out of date.
- **Roll back.** `POST /api/scan/defs/:id/rollback`. Only the `previous` version can be rolled back to. The two swap: the one you roll back from becomes `previous`, so you can switch forward again. Scans after the switch use the restored version.
- **Discard.** `POST /api/scan/defs/:id/discard`. Only a draft can be discarded. It becomes `discarded`, and its shadow stops.

## Near misses

Near misses are option setups that score just under the listing bar. They are shown for review, not as ideas.

- The setting is `listing.nearMissFrom`, a score from 0 to 100. Set it to empty to turn near misses off. The text view reads "Near misses: not shown" when it is off.
- A setup scores at or above `nearMissFrom` and below `minScore` is a near miss.
- When near misses are on, a setup that clears `minScore` but falls past `maxIdeas` is also a near miss.
- The latest pass stores its near misses for the Ideas tab. They never become ideas.
- The value must be below `minScore`. The schema refuses it otherwise.

Replay and compare results also list near misses.

## API

All routes are under `/api/scan` and need the `X-Api-Key` header. A request without a valid key returns `401`. The routes below are the Scan Lab routes. The rest of `/api/scan` is in [scan engine](scan-engine.md#api).

Errors use `400` for bad input, `404` for a missing record and `409` when the record is in the wrong state.

### Catalog

**`GET /api/scan/catalog?scope=stock|option`**

- `scope` is optional. With none, it returns both scopes.
- `200` returns `{ "fields": [ { "key", "scope", "label", "unit", "description", "source", "group" } ] }`.
- `400` when `scope` is not `stock` or `option`.

### Definitions

**`GET /api/scan/defs?kind=stock|option`**

- `200` returns `{ "active", "draft", "versions" }`. `active` and `draft` are a version's metadata or `null`. `versions` lists every version, newest first.
- A version's metadata is `{ id, kind, version, status, parentId, author, sourceText, notes, createdAt, promotedAt }`. `author` is `built-in`, `form` or `claude`.
- `400` when `kind` is missing or not `stock` or `option`.

**`GET /api/scan/defs/:id`**

- `200` returns the definition view:
  - `meta`, the metadata above;
  - `definition`, the JSON;
  - `text`, the rendered text;
  - `form`, the Settings sections and their items;
  - `diff`, the rows that differ from the parent;
  - `tests`, with `replay` (the latest replay or `null`) and `shadow` (the shadow view, newest 50 passes).
- `400` when `:id` is not a number.
- `404` when there is no such version.

**`POST /api/scan/defs/draft`**

- Body: `{ "kind": "stock|option", "baseId": 12, "edits": [ { "path": "strategies.long_call.terms[0].points", "value": 30 } ] }`.
  - `baseId` is optional and defaults to the active version.
  - `edits` has 1 to 500 items. A `value` is a number, a boolean, a string or `null`. `null` is valid only for `listing.nearMissFrom`.
- `201` returns the definition view of the new draft. It replaces the open draft, which becomes `discarded`.
- `400` when the body is not valid, an edit is out of range or the wrong type, or the result fails validation. The body is `{ "error": "…", "errors": [ "…" ] }`.
- `404` when `baseId` is not a version of that kind.

### Tests

**`GET /api/scan/inputs?kind=stock|option`**

- `200` returns `{ "passes": [ { "passAt", "definition" } ] }`, the stored passes that can be replayed, newest first, up to 200.
- `400` when `kind` is invalid.

**`POST /api/scan/defs/:id/replay`**

- Body: `{ "source": "latest" }` or `{ "source": "<pass time>" }`. The body is optional and defaults to `latest`. `source` must not be empty.
- `201` returns the stored replay: `{ id, defId, kind, source, passAt, createdAt, live, draft }`. `live` and `draft` are test results.
- `400` when the body is invalid or `:id` is not a number.
- `404` when the version does not exist, when no inputs are stored yet, or when there is no stored pass at that time.

**`GET /api/scan/defs/:id/replay`**

- `200` returns `{ "replay": <the latest replay> }`, or `{ "replay": null }` when none has run.
- `400` or `404` as above.

**`POST /api/scan/defs/:id/shadow`**

- Body: `{ "on": true }` or `{ "on": false }`.
- `200` returns the shadow view: `{ on, startedAt, count, passes }`. `passes` is the newest 50, each with `at`, `live` and `draft`.
- `400` when the body is not `{ "on": boolean }` or `:id` is not a number.
- `404` when the version does not exist.
- `409` when the version is not a draft.

**`GET /api/scan/defs/:id/shadow?limit=50`**

- `limit` is 1 to 500 and defaults to 50.
- `200` returns the shadow view, as above.
- `400` when `limit` is out of range.
- `404` when the version does not exist.

**`GET /api/scan/defs/:id/compare?source=replay|shadow&at=<pass time>`**

- `at` is optional and only used for `shadow`. It picks one shadow pass. Without it, the newest pass is used.
- `200` returns `{ source, at, live, draft, added, removed, rankChanges }`.
- `400` when `source` is not `replay` or `shadow`.
- `404` when there is no result of that source yet.

### Promote, roll back and discard

**`POST /api/scan/defs/:id/promote`**

- No body. `200` returns the definition view of the new active version.
- `409` when the version is not a draft, or when it has no replay yet.
- `400` or `404` for a bad or missing `:id`.

**`POST /api/scan/defs/:id/rollback`**

- No body. `200` returns the definition view of the restored version.
- `409` when the version is not `previous`.
- `400` or `404` for a bad or missing `:id`.

**`POST /api/scan/defs/:id/discard`**

- No body. `200` returns the definition view of the discarded draft.
- `409` when the version is not a draft.
- `400` or `404` for a bad or missing `:id`.

### Build with Claude

**`POST /api/scan/defs/build`**

- Body: `{ "kind": "stock|option", "baseId": 12, "text": "…" }`.
  - `baseId` is optional and defaults to the active version. `null` also means the active version.
  - `text` is 1 to 20,000 characters.
- `202` returns `{ "jobId": "…" }`. Poll the job with the route below.
- `400` when the body is not valid.
- `402` when the daily AI budget is spent.
- `404` when `baseId` is not a version of that kind.
- `409` when a build for that kind is already running.
- `503` when agents are off (`AGENTS_ENABLED=0`).

**`GET /api/scan/defs/build/:jobId`**

- `200` returns `{ status, draftId, notes, needsCode, error, refused, lines }`.
  - `status` is `running`, `done` or `error`.
  - `draftId` is the new draft when the status is `done`, otherwise `null`.
  - `notes` are Claude's notes. `needsCode` is a list of `{ request, reason }`.
  - `error` is the reason when the status is `error`. `refused` is `true` when the text was refused.
  - `lines` is one entry per changed line: `{ n, kind, section, text, before?, action, explanation }`.
- `404` when there is no such job. Jobs are kept in memory, so a restart ends them.

### Code requests

**`POST /api/scan/code-requests`**

- Body: `{ "kind": "stock|option", "draftId": 15, "request": "…", "reason": "…" }`.
  - `draftId` is optional. `request` is 1 to 2,000 characters. `reason` is optional, up to 2,000 characters.
- `201` returns the stored request: `{ id, kind, draftId, request, reason, status, createdAt }`. `status` starts as `open`.
- `400` when the body is not valid.
- `404` when `draftId` is not a version of that kind.

**`GET /api/scan/code-requests?kind=stock|option&status=open|done|declined`**

- Both filters are optional.
- `200` returns `{ "requests": [ … ] }`, newest first.
- `400` when a filter is not valid.

## Limits

- **The contract is chosen by the options sweep.** Each strategy takes the at-the-money call or put that the sweep judges. Scan Lab cannot pick a strike or an expiry.
- **Stock filters on live fields are empty at night.** The intraday factors (`price_vs_vwap`, `rsi_15m`, `rel_volume`, and their scores) are not in the nightly screen. A filter on one of them never passes in the nightly screen. The build prompt says so.
- **Reason wording changes only through Claude.** The sentences are text, and the Settings form does not edit text. Change the words in the text view and build a draft.
- **Replay only goes back as far as the snapshots.** Inputs and shadow passes are kept for 10 trading days. A stock draft that changes how a factor is ranked needs the nightly day's stored values to re-rank. Without them it cannot be replayed.
- **Code requests are not closed by the app.** No route changes a request's status yet.
- **Builds are not kept across a restart.** A job in progress when the server stops is lost, and its result is not saved.
- **One draft, one shadow, one build per kind at a time.** Starting another replaces or waits, as described above.
