# Positions CSV

The terminal learns what you hold from a CSV file you upload. Phase 1 has no broker sync, so the file is the only source. Upload it from the Ideas widget settings, or post it to `POST /api/positions/import`.

Contents: [How an import works](#how-an-import-works) · [Columns](#columns) · [Stock rows](#stock-rows) · [Option rows](#option-rows) · [Cost](#cost) · [Errors](#errors) · [API](#api)

## How an import works

- Each import **replaces the previous snapshot**. Positions that are not in the new file are removed. Import the whole portfolio every time, not only the changes.
- An import is all or nothing. If any row is invalid, nothing is stored and the previous snapshot stays.
- The stored snapshot feeds the universe (holdings are always scanned), the options data (held contracts are always streamed) and the covered-call setups (a call is only sold against shares you hold).
- Positions are read-only data for the terminal. Importing a file never places an order.

## Columns

The first row is the header. Column names are not case-sensitive, and their order does not matter. Extra columns are ignored.

| Column | Required | Used for | Format |
| --- | --- | --- | --- |
| `symbol` | Yes | A stock ticker, or an option's OCC symbol, or the underlying of an option (see [Option rows](#option-rows)) | Text, for example `AAPL` |
| `quantity` | Yes | Shares for a stock. Contracts for an option. Negative means short. | Whole number, for example `100` or `-2` |
| `cost` | No | Price per share (stock) or premium per share (option). See [Cost](#cost). | Number, for example `182.40` |
| `opened_at` | No | When the position was opened | `YYYY-MM-DD`, for example `2025-03-03` |
| `type` | No | `stock` or `option` | Text |
| `expiry` | Option rows | Expiry date of the contract | `YYYY-MM-DD` |
| `strike` | Option rows | Strike price in dollars | Number, for example `170` or `172.5` |
| `right` | Option rows | `call` or `put` | Text |

Leave an optional cell empty when you have no value. An empty `cost` is stored as no cost.

## Stock rows

A stock row has a ticker in `symbol` and no option columns.

```csv
symbol,quantity,cost,opened_at
AAPL,100,182.40,2025-03-03
MSFT,25,405.10,2025-07-14
```

Rules:

- `symbol` is the ticker. Only US-listed symbols are used.
- `quantity` is the number of shares. A short stock position is negative.

## Option rows

An option row can be written in one of two ways.

**1. The OCC symbol in `symbol`.** The full contract symbol is used as it is: the underlying, the expiry as `YYMMDD`, `C` or `P`, and the strike as eight digits in tenths of a cent (strike × 1000, padded to eight digits). Example: the 200 call on AAPL expiring 2026-12-18 is `AAPL261218C00200000`.

**2. The underlying in `symbol`, with `expiry`, `strike` and `right`.** The other columns describe the contract.

Both forms can be mixed in one file.

```csv
symbol,quantity,cost,opened_at,type,expiry,strike,right
AAPL261218C00200000,2,3.45,2026-06-10,,,,
NVDA,-1,3.10,2026-09-28,option,2026-11-20,170,put
MSFT,-1,6.80,2026-08-04,option,2026-10-30,420,call
```

Reading the rows above:

- Row 1 is 2 long calls on AAPL, written as an OCC symbol. Each contract covers 100 shares. The premium paid was $3.45 per share.
- Row 2 is 1 short put on NVDA, written with the underlying and the contract details. Quantity `-1` means you sold one put. This is the cash-secured put form.
- Row 3 is 1 short call on MSFT. Quantity `-1` means you sold one call. Short calls are covered only when you hold 100 shares or more of MSFT, which the snapshot also needs to show.

Rules for option rows:

- `quantity` is in contracts. Negative means you are short.
- `right` is `call` or `put`.
- `strike` is in dollars, not in the OCC form.
- `expiry` is the contract's expiry date.

## Cost

`cost` is what your broker shows as the average price, in the units the broker uses:

| Row | Meaning | Example |
| --- | --- | --- |
| Stock | Average price per share in dollars | `182.40` means $182.40 a share |
| Option | Premium per share in dollars, as brokers show it | `3.45` means $3.45 a share, or $345 for one contract |

The cost is **per share, not per contract**. Multiply by 100 to get the cash value of one contract. Leave `cost` empty when your broker shows none.

## Errors

When any row is invalid, the import is rejected and nothing is changed. The response lists the errors it found, each with the line number in the file. Every bad row is reported in one response, so you can fix them all in one pass.

```json
{
  "errors": [
    { "line": 3, "message": "…" },
    { "line": 5, "message": "…" }
  ]
}
```

Typical causes:

| Cause | Example |
| --- | --- |
| A required column is missing from the header | No `quantity` column |
| A quantity is not a whole number | `1.5` contracts |
| An OCC symbol does not parse | `AAPL-261218` |
| An option row is missing `expiry`, `strike` or `right` | Underlying in `symbol` and no `strike` |

Fix the file and upload it again. The previous snapshot stays in place until a valid import replaces it.

## API

`POST /api/positions/import` with the `x-api-key` header.

```json
{ "csv": "symbol,quantity,cost\nAAPL,100,182.40\n", "filename": "positions.csv" }
```

- `csv` is the full file text. Required.
- `filename` is optional. It is stored with the import for reference.

Success returns `200` with the number of positions stored:

```json
{ "imported": 3 }
```

A rejected file returns `400` with `{ "errors": [ { "line", "message" } ] }`, as above.

`GET /api/positions` returns the current snapshot and when it was imported. See [scan-engine.md](scan-engine.md#positions).
