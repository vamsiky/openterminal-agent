# Positions CSV

The terminal learns what you hold from a CSV file you upload. Phase 1 has no broker sync, so the file is the only source. Upload it from the Ideas widget settings, or post it to `POST /api/positions/import`.

Contents: [How an import works](#how-an-import-works) · [Columns](#columns) · [Dates and numbers](#dates-and-numbers) · [Stock rows](#stock-rows) · [Option rows](#option-rows) · [Several lots of one instrument](#several-lots-of-one-instrument) · [Cost](#cost) · [Errors](#errors) · [API](#api)

## How an import works

- Each import **replaces the previous snapshot**. Positions that are not in the new file are removed. Import the whole portfolio every time, not only the changes.
- An import is all or nothing. If any row is invalid, nothing is stored and the previous snapshot stays.
- Only US-listed symbols are accepted. A symbol that is not on the US listings is an error.
- The snapshot feeds the universe (holdings are always scanned), the options data (held contracts are always streamed) and the covered-call setups (a call is only sold against shares you hold).
- Importing never places an order.

## Columns

The first row is the header. Column names are not case-sensitive, and their order does not matter. Extra columns are ignored. The header must have a `symbol` column and a `quantity` column.

Each header name is matched after lower-casing it and treating `_`, `-`, `.` and `/` as spaces. The names below are accepted. Several names map to one column, so a broker's export usually works as it is.

| Column | Names accepted in the header | Required | Used for |
| --- | --- | --- | --- |
| `symbol` | `symbol`, `ticker`, `instrument`, `option symbol`, `contract` | Yes | A stock ticker, an option's OCC symbol, or the underlying of an option (see [Option rows](#option-rows)) |
| `quantity` | `quantity`, `qty`, `shares`, `contracts`, `position` | Yes | Shares for a stock, contracts for an option. Negative means short. |
| `cost` | `cost`, `avg cost`, `average cost`, `avg price`, `average price`, `cost per share` | No | Price per share (stock) or premium per share (option). See [Cost](#cost). |
| `opened_at` | `opened at`, `opened`, `open date`, `date opened`, `date acquired`, `acquired` | No | When the position was opened |
| `type` | `type`, `asset type`, `security type`, `asset class` | No | `stock`, `option`, `call` or `put` |
| `expiry` | `expiry`, `expiration`, `expiration date`, `exp` | Option rows | Expiry date of the contract |
| `strike` | `strike`, `strike price` | Option rows | Strike price in dollars |
| `right` | `right`, `put call`, `call put`, `option type` | Option rows | `call` or `put` |

Leave an optional cell empty when you have no value. An empty `cost` or `opened_at` is stored as no value.

## Dates and numbers

**Dates** (`opened_at`, `expiry`) are accepted as:

- `YYYY-MM-DD`, for example `2026-11-20`,
- `M/D/YYYY` or `M/D/YY`, for example `11/20/2026` or `11/20/26`.

A date that does not exist, such as `2026-02-30`, is an error.

**Numbers** (`quantity`, `cost`, `strike`) accept a plus or minus sign, a decimal point, a dollar sign and thousands separators. A value in parentheses is negative: `(5)` is −5. A value with a thousands separator must be quoted in the file: `"1,234"`.

**Cells.** A row may not have more cells than the header. Trailing empty cells are fine. A row with extra cells is an error, which is how an unquoted `1,234` is caught.

## Stock rows

A stock row has a ticker in `symbol` and no option columns.

```csv
symbol,quantity,cost,opened_at
AAPL,100,182.40,2025-03-03
MSFT,25,405.10,7/14/2025
```

Rules:

- `symbol` is the ticker. It must be a US-listed stock. A symbol with a dot, such as `BRK.B`, is accepted.
- `quantity` is the number of shares. A short stock position is negative.

## Option rows

A row is an option when any of these is true: `symbol` holds an OCC symbol, the `expiry`, `strike` or `right` column is filled, or `type` is `option`, `call` or `put`.

An option row can be written in one of two ways.

**1. The OCC symbol in `symbol`.** The contract symbol is used as it is: the underlying, the expiry as `YYMMDD`, `C` or `P`, and the strike as eight digits, in thousandths of a dollar (strike × 1000, padded to eight digits). The contract's `expiry`, `strike` and `right` columns are optional. If they are filled, they must agree with the symbol. A disagreement is an error.

Example: the 200 call on AAPL expiring 2026-12-18 is `AAPL261218C00200000`. The strike 172.5 put on NVDA expiring 2026-11-20 is `NVDA261120P00172500`.

**2. The underlying in `symbol`, with `expiry`, `strike` and `right`.** The contract is described by its columns.

Both forms can be mixed in one file. The `right` column also accepts `c` and `p`. When `right` is empty, `type` is used, if it is `call` or `put`.

```csv
symbol,quantity,cost,opened_at,type,expiry,strike,right
AAPL261218C00200000,2,3.45,2026-06-10,,,,
NVDA,-1,3.10,2026-09-28,option,2026-11-20,170,put
MSFT,-1,6.80,8/4/2026,option,10/30/2026,420,call
```

Reading the rows above:

- Row 1 is 2 long calls on AAPL, written as an OCC symbol. Each contract covers 100 shares. The premium paid was $3.45 per share.
- Row 2 is 1 short put on NVDA, written with the underlying and the contract details. Quantity `-1` means you sold one put. This is the cash-secured put form.
- Row 3 is 1 short call on MSFT. Quantity `-1` means you sold one call. A call is covered only when you also hold at least 100 shares of MSFT in the same file.

Rules for option rows:

- `quantity` is in contracts. Negative means you are short.
- `strike` is in dollars, not in the OCC form. It must be above zero.
- `expiry` is the contract's expiry date.
- The underlying must be a US-listed stock.

## Several lots of one instrument

Brokers often list one holding as several lots. Lots of the same instrument in one file are combined:

- Lots in the same direction are added together. The cost is the average of their costs, weighted by size. The `opened_at` date is the earliest one.
- A long lot and a short lot of the same instrument in one file are an error. Net them before you import.

A contract is one instrument. Two rows for the same contract are lots of one instrument, whichever form each row uses.

## Cost

`cost` is what your broker shows as the average price, in the units the broker uses:

| Row | Meaning | Example |
| --- | --- | --- |
| Stock | Average price per share, in dollars | `182.40` means $182.40 a share |
| Option | Premium per share, in dollars, as brokers show it | `3.45` means $3.45 a share, or $345 for one contract |

The cost is **per share, not per contract**. Multiply by 100 to get the cash value of one contract. A cost must be zero or more. Leave it empty when your broker shows none.

## Errors

When any row is invalid, the import is rejected and nothing is changed. The response lists every error found, with the line number in the file. Line 1 is the first line of the file, including any blank lines, so the header is usually line 1.

```json
{
  "errors": [
    { "line": 3, "message": "quantity \"1.5\" is not a non-zero whole number" },
    { "line": 5, "message": "NVDA261120P00172500 conflicts with the expiry, strike or right columns" }
  ]
}
```

The messages below are the errors the importer reports:

| Message | Cause |
| --- | --- |
| `the file is empty` | No text in the file. |
| `the header row needs symbol and quantity columns` | The header lacks one of the two required columns. |
| `the row has N cells but the header has M; quote values that contain commas` | An unquoted comma in a value, such as `1,000`. |
| `symbol is empty` | The `symbol` cell is blank. |
| `quantity "…" is not a non-zero whole number` | Zero, a fraction, or text. |
| `cost "…" is not a number` | A cost that is not a number, or a negative cost. |
| `opened_at "…" is not a date (use YYYY-MM-DD)` | An unreadable or impossible date. The `M/D/YYYY` form is also accepted. |
| `an option row needs an OCC symbol, or the underlying with a valid expiry, strike and right (call/put)` | An option row with a missing or invalid column. |
| `the OCC symbol … conflicts with the expiry, strike or right columns` | An OCC symbol and its columns describe different contracts. |
| `… is not a US-listed ticker` or `… is not a US-listed underlying` | The symbol is not a US stock on the listings. |
| `long and short lots of … in one file; net them before importing` | Long and short lots of one instrument in the same file. |

Fix the file and upload it again. The previous snapshot stays in place until a valid import replaces it.

## API

`POST /api/positions/import` with the `x-api-key` header.

```json
{ "csv": "symbol,quantity,cost\nAAPL,100,182.40\n", "filename": "positions.csv" }
```

- `csv` is the full file text. Required, and at most 1,000,000 characters.
- `filename` is optional, at most 200 characters. It is stored with the import.

A valid file returns `200`:

```json
{ "imported": 3 }
```

`imported` is the number of positions stored, after lots are combined.

A rejected file returns `400` with `{ "errors": [ { "line", "message" } ] }`, as above. A body that is not a JSON object with a `csv` text returns `400` with a single error on line 0.

`GET /api/positions` returns the current snapshot and when it was imported:

```json
{
  "importedAt": "2026-10-21T14:02:11.000Z",
  "positions": [
    { "kind": "stock", "symbol": "AAPL", "quantity": 100, "cost": 182.4, "openedAt": "2025-03-03" },
    { "kind": "option", "occ": "NVDA261120P00172500", "underlying": "NVDA", "expiry": "2026-11-20", "strike": 172.5, "right": "put", "quantity": -1, "cost": 3.1, "openedAt": "2026-09-28" }
  ]
}
```

`importedAt` is `null` before the first import. See [scan engine: positions](scan-engine.md#scan-status-and-forced-runs) for the rest of the API.
