# Research API

Reference for the analysis agents. Everything here is served by the terminal's server (`http://127.0.0.1:4000` in development) and was checked against live responses on 2026-10-21. Field names are FMP's (Financial Modeling Prep, Ultimate plan) unless a section says otherwise; the server adds a few computed fields, marked "added".

Contents: [Auth](#auth) · [Envelope and errors](#envelope-and-errors) · [Units and time](#units-and-time) · [How to research a stock](#how-to-research-a-stock) · [Summary](#summary) · [Per-symbol datasets](#per-symbol-datasets) · [Market-wide datasets](#market-wide-datasets) · [Screener](#screener) · [Older routes under /api](#older-routes-under-api) · [Freshness and caching](#freshness-and-caching) · [Gotchas](#gotchas)

## Auth

Send the key in the `x-api-key` header on every call. The key is the content of `data/.api-key` in the repo.

```sh
KEY=$(cat data/.api-key)
curl -s -H "x-api-key: $KEY" http://127.0.0.1:4000/api/research/NVDA
```

`/api/research/*` and `/api/estimates/*` refuse calls without the key (401). The older market routes (`/api/quotes`, `/api/history`, …) answer without it but are rate limited to 240 calls a minute per IP; a valid key lifts that limit.

## Envelope and errors

Every `/api/research` route answers

```json
{ "symbol": "AAPL", "dataset": "statements", "source": "fmp", "asOf": "2026-10-21T08:26:09.503Z", "data": … }
```

- `symbol` is present on per-symbol routes (uppercased, as asked: `BRK.B`). Market-wide routes leave it out, except the ETF routes.
- `dataset` names the dataset (it can differ slightly from the URL: `/etf-exposure` answers `etf-asset-exposure`).
- `source` is always `"fmp"`, even when the server filled a part from its own tables (the summary says which per section).
- `asOf` is when the server fetched the data from FMP (ISO UTC). A cached answer keeps the original time, so it tells how old the data is. `/screen` reports the oldest bulk refresh instead.
- `data` is an array (newest first unless the route says otherwise) or an object. An unknown symbol answers 200 with an empty array, or `null` for a single object.

Errors are `{ "error": "…", "feature": "research.<dataset>" }` except where noted:

| Status | When |
|---|---|
| 400 | Bad param, unknown param on `/screen`, or a foreign symbol ("US-listed symbols only (e.g. TSM for TSMC)"). The reserved words `market`, `screen`, `datasets` are not symbols. |
| 401 | Missing or wrong `x-api-key`. |
| 404 | `/transcripts/:year/:quarter` when FMP has no such transcript. |
| 502 | FMP failed (`error` carries FMP's status; the key is never in it). |
| 503 | `{ "error": "needs FMP_API_KEY" }`, or `/screen` before the first bulk load finished. |

Common query params (each route says which it takes; all are validated and a bad one is a 400):
`period=quarter|annual|ttm`, `limit` (integer 1–1000), `from` and `to` (`YYYY-MM-DD`, inclusive).

## Units and time

- Money is in the reporting currency of the row (`reportedCurrency`, USD for US companies), in whole units: `revenue: 68127000000` is $68.1 B. Per-share values are in dollars.
- **Fractions vs percents.** This is the main trap. Quote `changePercent`, `*Percent` fields, `weightPercentage`, `freeFloat`, `ownershipPercent`, sector `averageChange`, dividend-calendar `yield`, estimate `revisions` and `surprisePercent` are **percents** (`1.5` = 1.5 %). Ratios and margins (`netProfitMargin`, `freeCashFlowYield`, `earningsYield`), every `growth*` field, `dividendYield` / `dividendYieldTTM`, and `fcfYield` in the summary are **fractions** (`0.0031` = 0.31 %). The per-field notes below flag the exceptions.
- **Dates.** Research routes use ISO strings: `YYYY-MM-DD`, or `YYYY-MM-DD HH:MM:SS` where FMP sends a time (press releases and news are New York wall time, unparsed; filing `acceptedDate` is US Eastern wall time). `asOf` is ISO UTC. The older routes (`/api/quotes`, `/api/calendar`, `/api/earnings-history`, `/api/history`) use **unix seconds** (UTC); each section says which.
- Symbols: US-listed only. Share classes are written `BRK.B` in URLs and in the app, but FMP writes `BRK-B`, and rows copied from FMP carry `BRK-B` in their `symbol` field. The server converts the request; read `symbol` fields accordingly.

## How to research a stock

Call in this order. Stop when the question is answered; each step is one cheap call.

1. **`GET /api/research/:symbol`** (the [summary](#summary)): quote, profile, valuation, growth, last/next earnings with revisions, forward estimates, analyst view, ownership, recent releases, sector and peers. Every section has a `links` entry for its detail endpoint. A section that failed reads `{ "error": "…" }`; call its detail route to see why.
2. **Fundamentals:** `/api/research/:symbol/statements?type=income|balance|cashflow&period=quarter|annual|ttm&limit=8`, `/metrics`, `/growth`, `/segments` (revenue by product and region), `/scores` (Altman Z, Piotroski).
3. **Expectations:** `/estimates?period=quarter` (consensus per period plus the revision history), `/analysts` (targets, rating changes), `/valuation` (DCF).
4. **Who is buying:** `/institutional` (13F), `/insiders` (Form 4), `/congress`, `/float`; `/etf-exposure` for ETF demand.
5. **What was said and filed:** `/press-releases`, `/news`, `/filings?type=8-K`, `/transcripts` then `/transcripts/:year/:quarter`, `/transcripts/search?q=…`.
6. **Context:** `/peers`, `/api/research/market/sectors`, and `/api/research/screen` to compare with the rest of the market.
7. **Prices:** `/api/quotes?symbols=…` (live, with extended hours) and `/api/history/:symbol?range=…`.

```sh
KEY=$(cat data/.api-key); B=http://127.0.0.1:4000
curl -s -H "x-api-key: $KEY" "$B/api/research/NVDA" | jq '.data | {quote: .quote.price, pe: .valuation.pe, next: .earnings.next.date}'
# { "quote": 216.47, "pe": 27.23, "next": "2026-11-18" }

curl -s -H "x-api-key: $KEY" "$B/api/research/NVDA/statements?type=income&period=quarter&limit=4" | jq '.data[] | {date, period, revenue, epsDiluted}'
curl -s -H "x-api-key: $KEY" "$B/api/research/NVDA/transcripts/search?q=supply%20constraints&limit=3"
curl -s -H "x-api-key: $KEY" "$B/api/research/screen?sector=Technology&marketCapMin=1e11&ratingMin=4&sort=upsidePercent&limit=5&fields=beta,rating,upsidePercent"
```

Excerpt of a real summary (NVDA, 2026-10-21 pre-market; long arrays shortened to one item):

```json
{
  "symbol": "NVDA", "dataset": "summary", "source": "fmp", "asOf": "2026-10-21T08:30:37.121Z",
  "data": {
    "quote": { "price": 216.47, "changePercent": -0.2856, "marketState": "PRE", "source": "alpaca",
               "extended": { "pre": { "price": 220.33, "changePercent": 1.78, "live": true }, "post": null } },
    "valuation": { "pe": 27.23, "evToEbitda": 22.37, "priceToSales": 17.22, "fcfYield": 0.0243,
                   "dcf": 225.57, "price": 216.47, "dcfVsPricePercent": 4.2, "source": "bulk" },
    "earnings": {
      "last": { "date": "2026-08-26", "epsActual": 2.22, "epsEstimate": 2.09, "epsSurprisePercent": 6.22, "dayAfterChangePercent": 8.74 },
      "next": { "date": "2026-11-18", "timing": "amc", "epsEstimate": 2.49, "revenueEstimate": 108817900000,
                "revisions": { "7d": { "eps": null, "revenue": null } }, "revisionsTrackedSince": "2026-10-21" } },
    "analysts": { "consensus": { "strongBuy": 2, "buy": 58, "hold": 16, "sell": 3, "strongSell": 0, "consensus": "Buy" },
                  "priceTarget": { "lastQuarterAvg": 332.32, "upsidePercent": 53.52 } },
    "ownership": { "insiders": { "buys": { "transactions": 0 }, "sells": { "transactions": 25, "value": 967599313 }, "netValue": -967599313 } },
    "links": { "profile": "/api/research/NVDA/profile", "analysts": "/api/research/NVDA/analysts" }
  }
}
```

## Summary

### `GET /api/research/:symbol`

One call, all sections built in parallel from FMP and the server's own tables (the daily bulk tables first, per-symbol FMP calls where those lack the data). Dataset `summary`. Typical time 0.1–0.7 s, about 8 kB. Each section is independent: if it throws, or is still running after **3 s**, it is `{ "error": "…" }` and the others still return (status stays 200). Numbers here are in the units of the detail routes unless noted.

| Section | Fields |
|---|---|
| `quote` | `price`, `change`, `changePercent` (percent), `previousClose`, `open`, `high`, `low`, `volume`, `avgVolume`, `marketCap`, `week52High`, `week52Low`, `currency`, `marketState` (e.g. `PRE`), `time` (unix s of the price shown), `source` (`alpaca` live feed, else `fmp`/`stooq`), `asOf` (ISO), `extended` (`{ pre, post, overnight }`, each `{ price, change, changePercent, time, live }` or null; null when the source has none) |
| `profile` | `name`, `exchange`, `sector`, `industry`, `marketCap`, `beta`, `floatShares`, `freeFloatPercent` (percent), `sharesOutstanding`, `source` (`bulk`, or `fmp` for a symbol the bulk tables lack) |
| `valuation` | `pe` (TTM), `evToEbitda`, `priceToSales`, `fcfYield` (fraction), `dcf` (FMP's DCF value per share), `dcfDate`, `price` (the live price, else the bulk one), `dcfVsPricePercent` ((dcf / price − 1) × 100, percent), `source` |
| `growth` | `quarters`: the last 4 reported quarters, newest first, each `{ date, fiscalYear, period, revenue, epsDiluted, revenueYoYPercent, epsDilutedYoYPercent }` (YoY against the quarter ending 350–380 days earlier, percent, `null` if that quarter or a non-zero base is missing); `source` (`bulk`, `fmp` when the bulk statements lag or lack the history) |
| `earnings.last` | `date`, `fiscalPeriod`, `fiscalQtrEnd`, `epsActual`, `epsEstimate`, `epsSurprisePercent`, `revenueActual`, `revenueEstimate`, `dayAfterChangePercent` (price reaction, percent: for a before-open reporter the report-day close against the previous close, otherwise the next trading day's close against the report-day close), `reactionBasis` (says which) |
| `earnings.next` | `date`, `timing` (`bmo` before open / `amc` after close / `dmh` during hours / `null` unknown), `timingBasis` (`{ matched, total }` of the last reports that agreed), `epsEstimate`, `revenueEstimate`, `revisions` (`7d`/`30d`/`60d`/`90d`, each `{ eps, revenue }`: percent change of the consensus against that many days ago, `null` until the daily snapshots reach back that far), `revisionsTrackedSince` (first snapshot day) |
| `estimates` | `quarters` and `fiscalYears`: the next two unreported periods, each `{ date (period end), epsAvg, epsLow, epsHigh, revenueAvg, revenueLow, revenueHigh, ebitdaAvg, netIncomeAvg, numAnalystsEps, numAnalystsRevenue }` |
| `analysts` | `consensus` (`strongBuy`, `buy`, `hold`, `sell`, `strongSell`, `consensus`), `rating` (`rating` letter, `overallScore` 1–5), `priceTarget` (`lastQuarterCount`, `lastQuarterAvg`, `lastYearCount`, `lastYearAvg`, `upsidePercent` of the quarter average, else the year average, against the live price; the FMP fallback also has `high`, `low`, `consensus`, `median`), `recentGrades` (latest 5 `{ date, gradingCompany, previousGrade, newGrade, action }`), `source` |
| `ownership.institutional` | the latest 13F quarter past its filing deadline: `year`, `quarter`, `date`, `investorsHolding`, `investorsHoldingChange` (vs the previous quarter), `numberOf13Fshares`, `numberOf13FsharesChange`, `ownershipPercent` (percent of shares outstanding), `ownershipPercentChange` (percentage points), `newPositions`, `increasedPositions`, `reducedPositions`, `closedPositions` |
| `ownership.insiders` | last 90 days by transaction date, open-market only: `buys` and `sells` each `{ transactions, shares, value }` (dollars = shares × price), `netShares`, `netValue`, `windowDays`, `basis`, `truncated` (true if the 300 newest filings did not reach back 90 days). Awards, gifts, exercises and tax withholding are not counted |
| `ownership.congress` | last 90 days by transaction date: `purchases`, `sales` (counts), `trades` (up to 5 newest `{ chamber, name, type, amount (a dollar range string), transactionDate, disclosureDate, disclosureLagDays }`) |
| `recent` | `pressReleases` (latest 5 `{ publishedDate, title, publisher }`), `latestTranscript` (`{ fiscalYear, quarter, date }` or null) |
| `context` | `sector` (`{ name, exchange, date, averageChangePercent, pe }`, the sector's average 1-day change on that exchange, percent), `peers` (up to 6 largest US peers `{ symbol, changePercent }`), `peersAverageChangePercent` |
| `links` | section name → the detail endpoint (a string or a list) |

`ownership` is three independent parts: a failure in one reads `{ "error" }` in its place without failing the others. `GET /api/research/market`, `/screen` and `/datasets` are reserved words and answer 400 here; use the routes below.

## Per-symbol datasets

All under `/api/research/:symbol/…`, envelope as above, FMP field names unchanged. Foreign symbols answer 400.

### `/statements`
Params: `type=income|balance|cashflow` (default `income`), `period=quarter|annual|ttm` (default `quarter`), `limit` (default 8), `from`, `to`. Newest first. `ttm` returns a rolling TTM series (one row per recent quarter), not a single row. `from`/`to` filter after `limit` is applied, so pass a larger `limit` with a narrow window.
Every row: `date` (period end), `symbol`, `reportedCurrency`, `cik`, `filingDate`, `acceptedDate`, `fiscalYear` (string), `period` (`Q1`–`Q4`, `FY`) plus:
- **income:** `date`, `symbol`, `reportedCurrency`, `cik`, `filingDate`, `acceptedDate`, `fiscalYear`, `period`, `revenue`, `costOfRevenue`, `grossProfit`, `researchAndDevelopmentExpenses`, `generalAndAdministrativeExpenses`, `sellingAndMarketingExpenses`, `sellingGeneralAndAdministrativeExpenses`, `otherExpenses`, `operatingExpenses`, `costAndExpenses`, `netInterestIncome`, `interestIncome`, `interestExpense`, `depreciationAndAmortization`, `ebitda`, `ebit`, `nonOperatingIncomeExcludingInterest`, `operatingIncome`, `totalOtherIncomeExpensesNet`, `incomeBeforeTax`, `incomeTaxExpense`, `netIncomeFromContinuingOperations`, `netIncomeFromDiscontinuedOperations`, `otherAdjustmentsToNetIncome`, `netIncome`, `netIncomeDeductions`, `bottomLineNetIncome`, `eps`, `epsDiluted`, `weightedAverageShsOut`, `weightedAverageShsOutDil`
- **balance:** `date`, `symbol`, `reportedCurrency`, `cik`, `filingDate`, `acceptedDate`, `fiscalYear`, `period`, `cashAndCashEquivalents`, `shortTermInvestments`, `cashAndShortTermInvestments`, `netReceivables`, `accountsReceivables`, `otherReceivables`, `inventory`, `prepaids`, `otherCurrentAssets`, `totalCurrentAssets`, `propertyPlantEquipmentNet`, `goodwill`, `intangibleAssets`, `goodwillAndIntangibleAssets`, `longTermInvestments`, `taxAssets`, `otherNonCurrentAssets`, `totalNonCurrentAssets`, `otherAssets`, `totalAssets`, `totalPayables`, `accountPayables`, `otherPayables`, `accruedExpenses`, `shortTermDebt`, `capitalLeaseObligationsCurrent`, `taxPayables`, `deferredRevenue`, `otherCurrentLiabilities`, `totalCurrentLiabilities`, `longTermDebt`, `capitalLeaseObligationsNonCurrent`, `deferredRevenueNonCurrent`, `deferredTaxLiabilitiesNonCurrent`, `otherNonCurrentLiabilities`, `totalNonCurrentLiabilities`, `otherLiabilities`, `capitalLeaseObligations`, `totalLiabilities`, `treasuryStock`, `preferredStock`, `commonStock`, `retainedEarnings`, `additionalPaidInCapital`, `accumulatedOtherComprehensiveIncomeLoss`, `otherTotalStockholdersEquity`, `totalStockholdersEquity`, `totalEquity`, `minorityInterest`, `totalLiabilitiesAndTotalEquity`, `totalInvestments`, `totalDebt`, `netDebt`
- **cashflow:** `date`, `symbol`, `reportedCurrency`, `cik`, `filingDate`, `acceptedDate`, `fiscalYear`, `period`, `netIncome`, `depreciationAndAmortization`, `deferredIncomeTax`, `stockBasedCompensation`, `changeInWorkingCapital`, `accountsReceivables`, `inventory`, `accountsPayables`, `otherWorkingCapital`, `otherNonCashItems`, `netCashProvidedByOperatingActivities`, `investmentsInPropertyPlantAndEquipment`, `acquisitionsNet`, `purchasesOfInvestments`, `salesMaturitiesOfInvestments`, `otherInvestingActivities`, `netCashProvidedByInvestingActivities`, `netDebtIssuance`, `longTermNetDebtIssuance`, `shortTermNetDebtIssuance`, `netStockIssuance`, `netCommonStockIssuance`, `commonStockIssuance`, `commonStockRepurchased`, `netPreferredStockIssuance`, `netDividendsPaid`, `commonDividendsPaid`, `preferredDividendsPaid`, `otherFinancingActivities`, `netCashProvidedByFinancingActivities`, `effectOfForexChangesOnCash`, `netChangeInCash`, `cashAtEndOfPeriod`, `cashAtBeginningOfPeriod`, `operatingCashFlow`, `capitalExpenditure`, `freeCashFlow`, `incomeTaxesPaid`, `interestPaid`

### `/metrics`
Params: `period` (default `quarter`; `ttm` gives one row), `limit` (8), `from`, `to`. Newest first. Each row `{ symbol, date, fiscalYear, period, reportedCurrency, keyMetrics, ratios }`; the TTM row is `{ symbol, period: "TTM", keyMetrics, ratios }` with `TTM`-suffixed names (`evToSalesTTM`). Margins, yields and payout ratios are fractions; `dividendYieldPercentage` is a percent.
- `keyMetrics`: `marketCap`, `enterpriseValue`, `evToSales`, `evToOperatingCashFlow`, `evToFreeCashFlow`, `evToEBITDA`, `netDebtToEBITDA`, `currentRatio`, `incomeQuality`, `grahamNumber`, `grahamNetNet`, `taxBurden`, `interestBurden`, `workingCapital`, `investedCapital`, `returnOnAssets`, `operatingReturnOnAssets`, `returnOnTangibleAssets`, `returnOnEquity`, `returnOnInvestedCapital`, `returnOnCapitalEmployed`, `earningsYield`, `freeCashFlowYield`, `capexToOperatingCashFlow`, `capexToDepreciation`, `capexToRevenue`, `salesGeneralAndAdministrativeToRevenue`, `researchAndDevelopementToRevenue`, `stockBasedCompensationToRevenue`, `intangiblesToTotalAssets`, `averageReceivables`, `averagePayables`, `averageInventory`, `daysOfSalesOutstanding`, `daysOfPayablesOutstanding`, `daysOfInventoryOutstanding`, `operatingCycle`, `cashConversionCycle`, `freeCashFlowToEquity`, `freeCashFlowToFirm`, `tangibleAssetValue`, `netCurrentAssetValue`
- `ratios`: `grossProfitMargin`, `ebitMargin`, `ebitdaMargin`, `operatingProfitMargin`, `pretaxProfitMargin`, `continuousOperationsProfitMargin`, `netProfitMargin`, `bottomLineProfitMargin`, `receivablesTurnover`, `payablesTurnover`, `inventoryTurnover`, `fixedAssetTurnover`, `assetTurnover`, `currentRatio`, `quickRatio`, `solvencyRatio`, `cashRatio`, `priceToEarningsRatio`, `priceToEarningsGrowthRatio`, `forwardPriceToEarningsGrowthRatio`, `priceToEarningsDilutedRatio`, `priceToEarningsDilutedGrowthRatio`, `priceToBookRatio`, `priceToSalesRatio`, `priceToFreeCashFlowRatio`, `priceToOperatingCashFlowRatio`, `debtToAssetsRatio`, `debtToEquityRatio`, `debtToCapitalRatio`, `longTermDebtToCapitalRatio`, `financialLeverageRatio`, `workingCapitalTurnoverRatio`, `operatingCashFlowRatio`, `operatingCashFlowSalesRatio`, `freeCashFlowOperatingCashFlowRatio`, `debtServiceCoverageRatio`, `interestCoverageRatio`, `shortTermOperatingCashFlowCoverageRatio`, `operatingCashFlowCoverageRatio`, `capitalExpenditureCoverageRatio`, `dividendPaidAndCapexCoverageRatio`, `dividendPayoutRatio`, `dividendYield`, `dividendYieldPercentage`, `revenuePerShare`, `netIncomePerShare`, `interestDebtPerShare`, `cashPerShare`, `bookValuePerShare`, `tangibleBookValuePerShare`, `shareholdersEquityPerShare`, `operatingCashFlowPerShare`, `capexPerShare`, `freeCashFlowPerShare`, `netIncomePerEBT`, `ebtPerEbit`, `priceToFairValue`, `debtToMarketCap`, `effectiveTaxRate`, `enterpriseValueMultiple`, `dividendPerShare`

(`researchAndDevelopementToRevenue` is FMP's spelling.)

### `/growth`
Params: `period=quarter|annual` (`ttm` is a 400), `limit` (8), `from`, `to`. `data` is `{ income, balance, cashflow, financial }`, each an array newest first. All growth values are **fractions** (0.1 = 10 %) against the previous period in the series: year over year for `annual`, quarter over the previous quarter (sequential, not year over year) for `quarter`. For year-over-year quarterly growth compute it from `/statements` or read the summary's `growth.quarters`.
Row header in all four: `symbol`, `date`, `fiscalYear`, `period`, `reportedCurrency`.
- `income`: `symbol`, `date`, `fiscalYear`, `period`, `reportedCurrency`, `growthRevenue`, `growthCostOfRevenue`, `growthGrossProfit`, `growthGrossProfitRatio`, `growthResearchAndDevelopmentExpenses`, `growthGeneralAndAdministrativeExpenses`, `growthSellingAndMarketingExpenses`, `growthOtherExpenses`, `growthOperatingExpenses`, `growthCostAndExpenses`, `growthInterestIncome`, `growthInterestExpense`, `growthDepreciationAndAmortization`, `growthEBITDA`, `growthOperatingIncome`, `growthIncomeBeforeTax`, `growthIncomeTaxExpense`, `growthNetIncome`, `growthEPS`, `growthEPSDiluted`, `growthWeightedAverageShsOut`, `growthWeightedAverageShsOutDil`, `growthEBIT`, `growthNonOperatingIncomeExcludingInterest`, `growthNetInterestIncome`, `growthTotalOtherIncomeExpensesNet`, `growthNetIncomeFromContinuingOperations`, `growthOtherAdjustmentsToNetIncome`, `growthNetIncomeDeductions`
- `balance`: every balance line prefixed `growth…` (56 fields, e.g. `growthTotalAssets`, `growthNetDebt`; FMP's quirks `growthOthertotalStockholdersEquity`).
- `cashflow`: `symbol`, `date`, `fiscalYear`, `period`, `reportedCurrency`, `growthNetIncome`, `growthDepreciationAndAmortization`, `growthDeferredIncomeTax`, `growthStockBasedCompensation`, `growthChangeInWorkingCapital`, `growthAccountsReceivables`, `growthInventory`, `growthAccountsPayables`, `growthOtherWorkingCapital`, `growthOtherNonCashItems`, `growthNetCashProvidedByOperatingActivites`, `growthInvestmentsInPropertyPlantAndEquipment`, `growthAcquisitionsNet`, `growthPurchasesOfInvestments`, `growthSalesMaturitiesOfInvestments`, `growthOtherInvestingActivites`, `growthNetCashUsedForInvestingActivites`, `growthDebtRepayment`, `growthCommonStockIssued`, `growthCommonStockRepurchased`, `growthDividendsPaid`, `growthOtherFinancingActivites`, `growthNetCashUsedProvidedByFinancingActivities`, `growthEffectOfForexChangesOnCash`, `growthNetChangeInCash`, `growthCashAtEndOfPeriod`, `growthCashAtBeginningOfPeriod`, `growthOperatingCashFlow`, `growthCapitalExpenditure`, `growthFreeCashFlow`, `growthNetDebtIssuance`, `growthLongTermNetDebtIssuance`, `growthShortTermNetDebtIssuance`, `growthNetStockIssuance`, `growthPreferredDividendsPaid`, `growthIncomeTaxesPaid`, `growthInterestPaid`
- `financial`: `symbol`, `date`, `fiscalYear`, `period`, `reportedCurrency`, `revenueGrowth`, `grossProfitGrowth`, `ebitgrowth`, `operatingIncomeGrowth`, `netIncomeGrowth`, `epsgrowth`, `epsdilutedGrowth`, `weightedAverageSharesGrowth`, `weightedAverageSharesDilutedGrowth`, `dividendsPerShareGrowth`, `operatingCashFlowGrowth`, `receivablesGrowth`, `inventoryGrowth`, `assetGrowth`, `bookValueperShareGrowth`, `debtGrowth`, `rdexpenseGrowth`, `sgaexpensesGrowth`, `freeCashFlowGrowth`, `tenYRevenueGrowthPerShare`, `fiveYRevenueGrowthPerShare`, `threeYRevenueGrowthPerShare`, `tenYOperatingCFGrowthPerShare`, `fiveYOperatingCFGrowthPerShare`, `threeYOperatingCFGrowthPerShare`, `tenYNetIncomeGrowthPerShare`, `fiveYNetIncomeGrowthPerShare`, `threeYNetIncomeGrowthPerShare`, `tenYShareholdersEquityGrowthPerShare`, `fiveYShareholdersEquityGrowthPerShare`, `threeYShareholdersEquityGrowthPerShare`, `tenYDividendperShareGrowthPerShare`, `fiveYDividendperShareGrowthPerShare`, `threeYDividendperShareGrowthPerShare`, `ebitdaGrowth`, `growthCapitalExpenditure`, `tenYBottomLineNetIncomeGrowthPerShare`, `fiveYBottomLineNetIncomeGrowthPerShare`, `threeYBottomLineNetIncomeGrowthPerShare`

### `/scores`
Param `limit` (default 4, applies to `enterpriseValues` only). `data`: `scores` = `symbol`, `reportedCurrency`, `altmanZScore`, `piotroskiScore`, `workingCapital`, `totalAssets`, `retainedEarnings`, `ebit`, `marketCap`, `totalLiabilities`, `revenue` (`altmanZScore` below 1.8 is distress, above 3 is safe; `piotroskiScore` is 0–9); `enterpriseValues[]` (quarterly, newest first) = `symbol`, `date`, `stockPrice`, `numberOfShares`, `marketCapitalization`, `minusCashAndCashEquivalents`, `addTotalDebt`, `enterpriseValue`.

### `/segments`
Params `period=quarter|annual` (default `annual`), `limit` (8), `from`, `to`. `data` is `{ product, geographic }`; row = `{ symbol, fiscalYear (number), period, reportedCurrency, date, data }` where `data` maps the company's own segment names to revenue, e.g. `{ "iPhone": 209586000000, "Mac": 33708000000 }`. Newest first.

### `/estimates`
Params `period=quarter|annual` (default `annual`), `limit` (8), `from`, `to`. `data` is `{ estimates, nextReport }`.
- `estimates[]`: `symbol`, `date`, `revenueLow`, `revenueHigh`, `revenueAvg`, `ebitdaLow`, `ebitdaHigh`, `ebitdaAvg`, `ebitLow`, `ebitHigh`, `ebitAvg`, `netIncomeLow`, `netIncomeHigh`, `netIncomeAvg`, `sgaExpenseLow`, `sgaExpenseHigh`, `sgaExpenseAvg`, `epsAvg`, `epsHigh`, `epsLow`, `numAnalystsRevenue`, `numAnalystsEps`. **Ordered oldest first**, starting at the nearest period that may still be unreported (period end within the last 100 days for `quarter`, 370 for `annual`), because FMP lists 2030 back to 1996. `date` is the period end. `from` moves the start.
- `nextReport`: the server's own daily snapshots of the consensus for the next report: `{ reportDate, eps, revenue, history: [{ day, eps, revenue }] (oldest first), revisions: { "7d"|"30d"|"60d"|"90d": { eps, revenue } } }`. `revisions` are percent changes against that many days ago, `null` where the snapshots do not reach back; **snapshots start 2026-10-21**. All null/empty for a symbol not tracked. Same data as `/api/estimates/:symbol`.

### `/analysts`
Params `limit` (default 20; applies to `priceTargets`, `grades` and `gradesHistorical`), `from`, `to` (filter `priceTargets` by `publishedDate`, `grades` and `gradesHistorical` by `date`). `data`:
- `priceTargetSummary`: `symbol`, `lastMonthCount`, `lastMonthAvgPriceTarget`, `lastQuarterCount`, `lastQuarterAvgPriceTarget`, `lastYearCount`, `lastYearAvgPriceTarget`, `allTimeCount`, `allTimeAvgPriceTarget`, `publishers` (`publishers` is parsed into an array); count and average of targets published in the last month, quarter, year and ever.
- `priceTargetConsensus`: `symbol`, `targetHigh`, `targetLow`, `targetConsensus`, `targetMedian`
- `priceTargets[]` (newest first): `symbol`, `publishedDate`, `newsURL`, `newsTitle`, `analystName`, `priceTarget`, `adjPriceTarget`, `priceWhenPosted`, `newsPublisher`, `newsBaseURL`, `analystCompany`
- `grades[]` (rating changes, newest first): `symbol`, `date`, `gradingCompany`, `previousGrade`, `newGrade`, `action`. FMP sends the whole history (about 1,800 rows for AAPL); the route applies the date filter, then keeps the newest `limit`.
- `gradesConsensus`: `symbol`, `strongBuy`, `buy`, `hold`, `sell`, `strongSell`, `consensus`
- `gradesHistorical[]` (monthly, newest first): `symbol`, `date`, `analystRatingsStrongBuy`, `analystRatingsBuy`, `analystRatingsHold`, `analystRatingsSell`, `analystRatingsStrongSell`
- `ratingsSnapshot`: `symbol`, `rating`, `overallScore`, `discountedCashFlowScore`, `returnOnEquityScore`, `returnOnAssetsScore`, `debtToEquityScore`, `priceToEarningsScore`, `priceToBookScore` (`rating` letter S/A/B/C/D with ±; scores 1–5).
A part FMP does not serve is `null` / `[]`.

### `/valuation`
`data`: `{ dcf, leveredDcf }`, each `{ symbol, date, dcf, "Stock Price" }` or null. `dcf` is the fair value per share; `"Stock Price"` (key with a space) is the price it was struck at.

### `/peers`
`data[]`: `symbol`, `companyName`, `price`, `mktCap` (`mktCap` in dollars). Foreign listings are dropped; US OTC lines of foreign firms can remain.

### `/profile`
`data`: `{ profile, executives, employeeCount }`.
- `profile`: `symbol`, `price`, `marketCap`, `beta`, `lastDividend`, `range`, `change`, `changePercentage`, `volume`, `averageVolume`, `companyName`, `currency`, `cik`, `isin`, `cusip`, `exchangeFullName`, `exchange`, `industry`, `website`, `description`, `ceo`, `sector`, `country`, `fullTimeEmployees`, `phone`, `address`, `city`, `state`, `zip`, `image`, `ipoDate`, `defaultImage`, `isEtf`, `isActivelyTrading`, `isAdr`, `isFund` (`fullTimeEmployees` is a string; `range` is the 52-week range `"low-high"`; `lastDividend` is the annual dividend per share; `changePercentage` is a percent).
- `executives[]`: `title`, `name`, `pay`, `currencyPay`, `gender`, `yearBorn`, `titleSince`, `active`
- `employeeCount`: `{ latest, history[] }`, history rows from 10-K filings (`periodOfReport`, `filingDate`, `formType`, `employeeCount`, `source`, …), newest first.

### `/etf-exposure`
Param `limit` (default 100). ETFs that hold this stock, heaviest first: `symbol`, `asset`, `sharesNumber`, `weightPercentage`, `marketValue`. `weightPercentage` is the stock's weight in that ETF, percent. Foreign-listed ETFs and weights over 100 (FMP junk) are dropped.

### `/institutional`
Params `year` and `quarter` (together, `quarter` 1–4; both or neither). Without them: the newest quarter whose 45-day 13F deadline has passed (on 2026-10-21 that is 2026 Q2: Q3 only has early filers), falling back one quarter if that is empty. An explicit quarter never falls back. `data`: `{ year, quarter, summary, holders }`.
- `summary` (null if none): `symbol`, `cik`, `date`, `investorsHolding`, `lastInvestorsHolding`, `investorsHoldingChange`, `numberOf13Fshares`, `lastNumberOf13Fshares`, `numberOf13FsharesChange`, `totalInvested`, `lastTotalInvested`, `totalInvestedChange`, `ownershipPercent`, `lastOwnershipPercent`, `ownershipPercentChange`, `newPositions`, `lastNewPositions`, `newPositionsChange`, `increasedPositions`, `lastIncreasedPositions`, `increasedPositionsChange`, `closedPositions`, `lastClosedPositions`, `closedPositionsChange`, `reducedPositions`, `lastReducedPositions`, `reducedPositionsChange`, `totalCalls`, `lastTotalCalls`, `totalCallsChange`, `totalPuts`, `lastTotalPuts`, `totalPutsChange`, `putCallRatio`, `lastPutCallRatio`, `putCallRatioChange`. Fields with `last…` are the previous quarter, `…Change` the difference. `ownershipPercent` is a percent of shares outstanding; `totalInvested` dollars.
- `holders[]` (25 largest by shares): `date`, `cik`, `filingDate`, `investorName`, `symbol`, `securityName`, `typeOfSecurity`, `securityCusip`, `sharesType`, `putCallShare`, `investmentDiscretion`, `industryTitle`, `weight`, `lastWeight`, `changeInWeight`, `changeInWeightPercentage`, `marketValue`, `lastMarketValue`, `changeInMarketValue`, `changeInMarketValuePercentage`, `sharesNumber`, `lastSharesNumber`, `changeInSharesNumber`, `changeInSharesNumberPercentage`, `quarterEndPrice`, `avgPricePaid`, `isNew`, `isSoldOut`, `ownership`, `lastOwnership`, `changeInOwnership`, `changeInOwnershipPercentage`, `holdingPeriod`, `firstAdded`, `performance`, `performancePercentage`, `lastPerformance`, `changeInPerformance`, `isCountedForPerformance`. `weight` is the position's share of that investor's portfolio (percent), `ownership` the investor's share of this company (percent).

### `/insiders`
Param `limit` (default 50, max 1000). `data`: `{ trades, statistics }`.
- `trades[]` (Form 4, newest first): `symbol`, `filingDate`, `transactionDate`, `reportingCik`, `companyCik`, `transactionType`, `securitiesOwned`, `reportingName`, `typeOfOwner`, `acquisitionOrDisposition`, `directOrIndirect`, `formType`, `securitiesTransacted`, `price`, `securityName`, `url`. `transactionType` is FMP's code-name: `P-Purchase`, `S-Sale`, `A-Award`, `M-Exempt`, `F-InKind` (tax withholding), `G-Gift`. `acquisitionOrDisposition` is `A` or `D`. `price` is dollars per share (0 for awards and gifts). Dates `YYYY-MM-DD`.
- `statistics[]` (quarterly, newest first, all history): `symbol`, `cik`, `year`, `quarter`, `acquiredTransactions`, `disposedTransactions`, `acquiredDisposedRatio`, `totalAcquired`, `totalDisposed`, `averageAcquired`, `averageDisposed`, `totalPurchases`, `totalSales`

### `/congress`
Param `limit` (default 50). Senate and House trades merged, newest transaction first: `symbol`, `senateID`, `disclosureDate`, `transactionDate`, `firstName`, `lastName`, `office`, `district`, `owner`, `assetDescription`, `assetType`, `type`, `amount`, `capitalGainsOver200USD`, `comment`, `link`, `chamber`, `disclosureLagDays`. Added: `chamber` (`senate`/`house`) and `disclosureLagDays`. `amount` is a dollar range string (`"$1,001 - $15,000"`), never an exact figure. `senateID` is also used for House members. `type` is `Purchase`, `Sale`, `Sale (Partial)`, `Sale (Full)`, `Exchange`.

### `/float`
`data`: `symbol`, `date`, `floatShares`, `outstandingShares`, `freeFloat`, `source` or null. `freeFloat` is a percent; `floatShares` and `outstandingShares` are shares; `date` is when FMP computed it.

### `/transcripts`
- `GET /transcripts`: `[{ fiscalYear, quarter, date }]`, newest first (all quarters FMP has).
- `GET /transcripts/:year/:quarter`: `{ fiscalYear, quarter, date, content }` (plain text, about 45 kB; speakers as `Name: text`). Fetched on first request, then served from the local store forever. 404 if FMP has none. Some symbols have none (BRK.B).
- `GET /transcripts/search?q=…&limit=10`: full-text search over the transcripts **already stored locally** for this symbol (`q` 1–200 chars; every word must appear; `limit` 1–50): `[{ fiscalYear, quarter, date, snippet }]` newest first. The server stores the latest 4 for every watchlist symbol and each new report within a day; fetch a transcript once (above) to make it searchable.

### `/press-releases`, `/news`
Params `limit` (20 / 30), `from`, `to`. Newest first: `symbol`, `publishedDate`, `publisher`, `title`, `site`, `text`, `url`. `text` is the full body, `publishedDate` New York wall time `YYYY-MM-DD HH:MM:SS` (`00:00:00` when only the date is known). Without `from`/`to`, press releases reach back about 3 months. A symbol search also returns third-party releases that merely mention the company. `/news` is FMP stock news, not the Alpaca feed of `/api/news`.

### `/filings`
Params `type` (e.g. `8-K`, matched case-insensitively here; `8-K` also returns `8-K/A`), `limit` (20), `from`, `to` (default: the last 730 days). Newest first: `symbol`, `cik`, `filingDate`, `acceptedDate`, `formType`, `link`, `finalLink`. `link` is the EDGAR index page, `finalLink` the document itself; `filingDate` can carry a `00:00:00` time.

## Market-wide datasets

Under `/api/research/market/…`; no `symbol` in the envelope (ETF routes echo theirs). Calendars (`ipos`, `splits`, `dividends`) are sorted **ascending by date**; the rest newest first. Date params `from`/`to` are `YYYY-MM-DD`; `from > to` is a 400.

| Route | Params | `data` |
|---|---|---|
| `insiders/latest` | `limit` (100) | Form 4 across all issuers, the `trades` shape above. |
| `congress/latest` | `limit` (100) | Senate + House newest disclosures first, with `chamber`, `disclosureLagDays`; `symbol` is often `""` (bonds, funds). |
| `institutional/latest-filings` | `limit` (50) | 13F filers' latest filings: `cik`, `name`, `date`, `filingDate`, `acceptedDate`, `formType`, `link`, `finalLink` |
| `press-releases/latest` | `limit` (50) | FMP's global press-release feed, the press-release shape above. |
| `filings/8k/latest` | `limit` (50), `from`, `to` (default last 7 days) | 8-K and 8-K/A filings, the `/filings` shape. |
| `ipos` | `from`, `to` (default today ∓ 30 days) | `symbol`, `date`, `daa`, `company`, `exchange`, `actions`, `shares`, `priceRange`, `dealSize`, `marketCap`, `prospectus`, `disclosures`, `lockupExpiry`. `prospectus[]` are the IPO's 424B filings (`pricePublicPerShare`, `pricePublicTotal`, `proceedsBeforeExpensesTotal`, `form`, `url`, …), `disclosures[]` registration filings; `lockupExpiry` is **estimated** as IPO date + 180 days. Includes SPAC units, warrants and rights. Keep ranges to a few months. |
| `lockups` | `days` (1–180, default 30) | IPOs whose estimated lock-up ends in the next `days` days, soonest first: `symbol`, `date`, `daa`, `company`, `exchange`, `actions`, `shares`, `priceRange`, `dealSize`, `marketCap`, `lockupExpiry`, `ipoPrice`, `price`, `changeSinceIpoPercent`. `ipoPrice` from the prospectus (null if none), `price` the current price, `changeSinceIpoPercent` percent. |
| `mergers` | `limit` (50) | Latest M&A filings: `symbol`, `companyName`, `cik`, `targetedCompanyName`, `targetedCik`, `targetedSymbol`, `transactionDate`, `acceptedDate`, `link` |
| `splits` | `from`, `to` (today … +30 days) | `symbol`, `date`, `numerator`, `denominator`, `splitType` |
| `dividends` | `from`, `to` (today … +30 days) | `symbol`, `date`, `recordDate`, `paymentDate`, `declarationDate`, `adjDividend`, `dividend`, `yield`, `frequency`. `yield` is a **percent** here; `dividend` per share in dollars. US listings only (FMP writes US share classes as BRK-B, so dotted symbols are dropped). |
| `sectors` | `date`, `exchange=NASDAQ|NYSE` | Best performer first: `date`, `sector`, `exchange`, `averageChange`, `pe`. `averageChange` is the day's average change in percent; `pe` the sector P/E. Without `date` it uses the last day FMP has rows for. |
| `industries` | same | the same with `industry` in place of `sector`. |
| `sectors/history` | `sector` (required), `exchange`, `from`, `to` | daily rows newest first, same fields; about 3 weeks without a range. `industries/history` takes `industry`. |
| `index/:name` | `name=sp500|nasdaq|dowjones` (`nasdaq` is the Nasdaq-100) | constituents: `symbol`, `name`, `sector`, `subSector`, `headQuarter`, `dateFirstAdded`, `cik`, `founded` |
| `index/:name/changes` | `from`, `to`, `limit` | membership changes newest first: `dateAdded`, `addedSecurity`, `removedTicker`, `removedSecurity`, `date`, `symbol`, `reason`, `changeType`, `addedTicker` (`changeType` `addition`, `removal` or `replacement`) |
| `etf/:symbol/holdings` | `limit` | an ETF's holdings, heaviest first: `symbol`, `asset`, `name`, `isin`, `securityCusip`, `sharesNumber`, `weightPercentage`, `marketValue`, `updatedAt`. Non-ETFs give `[]`. |
| `etf/:symbol/exposure` | – | `{ info, countryWeightings: [{ country, weightPercentage }], sectorWeightings: [{ symbol, sector, weightPercentage }] }`; `info` = `symbol`, `name`, `isin`, `assetClass`, `securityCusip`, `domicile`, `website`, `etfCompany`, `expenseRatio`, `assetsUnderManagement`, `avgVolume`, `inceptionDate`, `nav`, `navCurrency`, `holdingsCount`, `isActivelyTrading`, `updatedAt` |
| `datasets` | – | the status of the local bulk tables, see below. |

### Screener

`GET /api/research/screen`: filters the daily bulk tables (US stocks; ETFs, funds and delisted names excluded). Unknown params are a 400. Fast (milliseconds), no FMP call.

- Filters: `sector`, `industry` (exact, case-insensitive, FMP's names such as `Technology`, `Banks - Regional`), `exchange` (comma list of NASDAQ, NYSE, AMEX, CBOE, OTC; default is the first four), `marketCapMin`, `marketCapMax`, `peMin`, `peMax` (TTM P/E), `epsGrowthMin`, `revenueGrowthMin` (latest fiscal year, **fractions**: 0.2 = 20 %), `dividendYieldMin` (fraction), `betaMax`, `ratingMin` (1–5), `upsideMin` (percent: average price target vs price).
- `sort` (any numeric field below, default `marketCap`), `order=asc|desc` (default `desc`, nulls last), `limit` (1–500, default 50), `fields` (comma list of extra fields to return).
- Rows always carry `symbol, companyName, sector, industry, exchange, price, marketCap`, then the requested `fields`, then any field a filter or the sort used.
- All fields: `symbol, companyName, exchange, sector, industry, country, isAdr, price, marketCap, beta, averageVolume, priceToEarningsRatioTTM, priceToEarningsGrowthRatioTTM, priceToBookRatioTTM, priceToSalesRatioTTM, priceToFreeCashFlowRatioTTM, netIncomePerShareTTM, dividendYieldTTM, dividendPayoutRatioTTM, grossProfitMarginTTM, operatingProfitMarginTTM, netProfitMarginTTM, debtToEquityRatioTTM, currentRatioTTM, enterpriseValueTTM, evToEBITDATTM, evToSalesTTM, netDebtToEBITDATTM, returnOnEquityTTM, returnOnAssetsTTM, returnOnInvestedCapitalTTM, earningsYieldTTM, freeCashFlowYieldTTM, growthRevenue, growthEPS, growthFiscalYear, rating, overallScore, lastQuarterAvgPriceTarget, lastYearAvgPriceTarget, upsidePercent, consensus, dcf`. Added: `upsidePercent` (percent), `growthFiscalYear` (string: the fiscal year the two growth fields come from).
- `asOf` is the oldest daily refresh among the tables used.

```sh
curl -s -H "x-api-key: $KEY" "$B/api/research/screen?epsGrowthMin=0.5&revenueGrowthMin=0.2&upsideMin=10&ratingMin=4&limit=5"
```

### Bulk table status

`GET /api/research/market/datasets` lists the 13 bulk datasets behind the screener and the summary: `dataset`, `table`, `schedule`, `rows`, `lastRunRows`, `bytes`, `calls`, `durationMs`, `updatedAt`, `error`, `errorAt`. `schedule` is `daily` (after 6 AM New York) or `weekly` (statements). A non-null `error` means the last refresh failed and the older rows are being served.

## Older routes under /api

These predate the research layer and keep their own shapes (no envelope: the body is the data). Send the key anyway.

| Route | Params | Response | Units |
|---|---|---|---|
| `GET /api/quotes` | `symbols` (comma list, up to 150) | array of quotes, same order; foreign symbols are skipped | `price, change, open, high, low, previousClose, bid, ask` dollars; `changePercent` percent; `volume`, `avgVolume`, `sharesOutstanding` shares; `marketCap` dollars; `pe`, `eps`; `dividendYield` fraction; `week52High/Low`; `beta`; `marketState`; `time` unix seconds; `asOf` ISO; `source` (`alpaca` live, `fmp`, `stooq`); `live` bool; `extended` `{ pre, post, overnight }` with `price, change, changePercent, time (ISO), live`. |
| `GET /api/history/:symbol` | `range=1D|5D|1M|6M|1Y|5Y|MAX` (default `6M`) | array of candles oldest first `{ time, open, high, low, close, volume }` | `time` unix seconds. `1D` = 5-minute bars, `5D` = 15-minute, `1M` = hourly (pre-market and after hours included); `6M` and longer = daily bars at UTC midnight. The last candle carries the live price. |
| `GET /api/calendar` | `symbols` (comma list, up to 500) | array `{ symbol, nextEarningsDate, lastEarningsDate, epsForecast, revenueForecast, lastEps, lastEpsEstimate, lastSurprisePercent, lastRevenue, timing, timingBasis }` | dates unix seconds (UTC midnight); `lastSurprisePercent` percent; `timing` `bmo`/`amc`/`dmh`/null inferred from press-release times, `timingBasis` `{ matched, total }`. |
| `GET /api/earnings-history/:symbol` | – | up to 12 quarters, newest first; an `upcoming: true` row first with only the consensus | `{ fiscalQtrEnd, fiscalPeriod, upcoming?, dateReported (unix s), eps, consensusForecast, surprisePercent (percent), revenue, revenueEstimate, dayAfterChangePercent (percent) }`. `dayAfterChangePercent` is the price reaction in percent, using the report timing as the summary does: for a before-open (`bmo`) reporter the report-day close against the previous close, otherwise the next trading day's close against the report-day close. |
| `GET /api/estimates/:symbol` | `report=YYYY-MM-DD` (default: the next report) | `{ symbol, next: { reportDate, eps, revenue } \| null, history: [{ day, eps, revenue }], revisions }` | the same snapshots as `/estimates`' `nextReport`; `revisions` percent; needs the key. |
| `GET /api/econ-calendar` | – | the next 14 days of US data releases and Fed events `{ title, country, date (ISO UTC), impact (High/Medium/Low/Holiday), forecast, previous, actual }` | `forecast`, `previous`, `actual` are strings in the release's own unit (e.g. `"-0.1"`), null until published. |
| `GET /api/news` | `symbol` (optional) | up to 40 `{ title, link, publisher, publishedAt (ISO), symbol }` | Alpaca/Benzinga headlines; needs Alpaca keys. |
| `GET /api/options/:symbol` | `expiry=YYYY-MM-DD` (default: the nearest) | `{ symbol, underlyingPrice, expirationDates, selectedDate, calls[], puts[] }`, each contract `{ contract, strike, lastPrice, bid, ask, change, percentChange, volume, openInterest, impliedVolatility, inTheMoney, delta, gamma, theta, vega, rho }` | `openInterest` and the Greeks are `null` (the data host does not provide them). |
| `GET /api/insider/:symbol` | – | Form 4 transactions from SEC EDGAR, newest first `{ filingDate, transactionDate, ownerName, ownerTitle, isDirector, isOfficer, isTenPercentOwner, transactionCode, acquiredDisposed, shares, pricePerShare, value, sharesOwnedAfter }` | `transactionCode` is the SEC letter (`P` buy, `S` sale, `A` award, `M` exercise, `F` withholding, `G` gift); `value` dollars. |
| `GET /api/short-volume/:symbol` | – | `{ date, shortVolume, shortExemptVolume, totalVolume, shortVolumePercent }` or `null` | FINRA daily Reg SHO file for the last published trading day; `date` is `YYYYMMDD`; `shortVolumePercent` percent. This is short *sale volume*, not short interest. |

## Freshness and caching

"Cache" is the server's in-memory cache; a repeat call inside it is a few milliseconds and keeps the first `asOf`.

| Data | Freshness at the source | Cache |
|---|---|---|
| Quotes (`/api/quotes`, summary `quote`) | live (Alpaca stream, real time) for US stocks; extended hours included | 15 s for fallbacks |
| History | live for the last bar | 2–20 s |
| Statements, metrics, growth, scores, segments, valuation, peers, profile | per FMP update, after each filing; DCF daily | 24 h |
| `estimates`, `analysts`, `grades` | per FMP update (consensus moves daily) | 1 h |
| Estimate snapshots (`nextReport`, `/api/estimates`, `/api/calendar`) | captured once a day by the server | local table |
| Institutional (13F), insiders, congress, float | 13F quarterly with a 45-day lag; Form 4 within 2 business days; congress within 45 days of the trade | 24 h |
| Press releases, news, 8-K feeds, `insiders/latest` | per FMP update | 5 min |
| `congress/latest`, 13F latest filings, per-symbol filings, transcript date list | per FMP update | 1 h |
| Transcripts | after each call (same day to a day later) | stored locally for good once fetched |
| Calendars, IPOs, splits, dividends, sector/industry snapshots | daily | 1 h |
| Index and ETF data, executives, employees | monthly to daily | 24 h |
| M&A feed | per FMP update | 5 min |
| Bulk tables (screener, summary valuation/analysts/profile) | refreshed daily after 6 AM New York; statements weekly | local tables, see `/market/datasets` |
| Earnings history (`/api/earnings-history`), Econ calendar | hourly / daily | 1 h / 15 min |
| News (`/api/news`), options | live | 60 s |
| Insider (`/api/insider`) | per SEC | 1 h |
| Short volume | daily after close | 6 h |
| Summary | – | none of its own: it reuses the caches above |

## Gotchas

- **13F lag.** Institutional holdings for a quarter appear up to 45 days after quarter end, most of them near the deadline. The default quarter is the newest one past its deadline (2026 Q2 on 2026-10-21); passing a newer quarter returns only the early filers (about a quarter of the holders) and understates ownership. Holdings are positions at quarter end, not today.
- **Congress disclosure lag.** Trades are reported up to 45 days later (`disclosureLagDays`), and `amount` is only a range. The summary windows by *transaction* date, so a trade made last week may not be visible yet.
- **Estimate revisions start 2026-10-21.** The server began snapshotting consensus estimates that day, so `revisions` are `null` until 7, 30, 60 and 90 days of snapshots exist (the first 7d value appears 2026-10-28). Do not read a null as "no change".
- **Earnings timing is inferred.** `bmo`/`amc`/`dmh` is voted from the publication time of the company's last four earnings press releases; `null` when they disagree or none were found. `timingBasis` shows the vote. A report date can also move; `next.date` is the latest FMP date.
- **US-only symbols.** Foreign listings (`SAP.DE`, `7203.T`) are a 400 on every route; use the US ADR (`TSM`, `SAP`). A single trailing letter after a dot counts as a share class (`BRK.B`), so a few foreign `.L`/`.T` tickers slip through the filter.
- **`BRK.B` vs `BRK-B`.** Use `BRK.B` in URLs. FMP rows echo `BRK-B` in `symbol`, so match on the requested symbol, not the row's. FMP has no transcripts for BRK-B.
- **Bulk tables lag.** Profile, ratios, targets and DCF in the summary can be up to a day old; statements in the bulk tables refresh weekly and cover the next, current and previous fiscal years (so FY2027 companies like NVDA are included). If the bulk quarters are fewer than 8 or older than the last reported quarter the summary reads FMP's per-symbol statements instead (`growth.source: "fmp"`).
- **EPS figures can differ between routes.** `earnings.last.epsActual` and `/api/earnings-history` `eps` come from FMP's earnings feed (the basis the consensus uses); `/statements` `eps`/`epsDiluted` and the summary's `growth` come from the income statement. They need not match: NVDA's Q2 FY2027 shows 2.22 in the earnings feed (consensus 2.09) and 2.46 diluted in the statement. FMP does not say which basis each uses (unverified); compare an actual with an estimate only within the earnings feed.
- **Statement endpoints.** `fiscalYear` is a string; `period=ttm` is a rolling series; for fiscal years that do not match the calendar year use `fiscalYear` and `period`, not `date`, to line up quarters. FMP's `growth` series compare each period with the previous one of the same kind, and a restated period can change old rows.
- **FMP quirks kept as is:** `researchAndDevelopementToRevenue`, `growthNetCashProvidedByOperatingActivites`, `growthOtherInvestingActivites` (misspelled), `"Stock Price"` with a space in the DCF rows, `senateID` for House members, `fullTimeEmployees` as a string, `ebitgrowth` and `epsgrowth` lowercase.
- **Units differ by route.** Percent versus fraction is listed per field above; the quickest checks are `changePercent` (percent), `dividendYield` on quotes and ratios (fraction), dividend-calendar `yield` (percent), `growth*` (fractions), `freeFloat` and `ownershipPercent` (percents), screen `growthEPS` (fraction) and `upsidePercent` (percent).
- **Time zones.** Press-release and news `publishedDate` are New York wall time, not UTC. Unix seconds on the older routes are UTC. Earnings dates are the report day, and a before-open report moves the same day's price.
- **Limits before filters.** On the statement-like routes `from`/`to` are applied after FMP's `limit`; a narrow window with a small limit returns fewer rows than exist.
- **Rate limit.** FMP allows 3,000 calls a minute; a summary costs up to about 20 FMP calls the first time, none when cached. Avoid fanning out the market-wide routes for every symbol.
