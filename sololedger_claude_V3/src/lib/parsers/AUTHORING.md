# Authoring an exchange CSV parser

This directory holds the CSV/XLSX import parsers. Every parser normalizes a
raw exchange export into the single `Transaction[]` shape the calculation
engine consumes (`src/types/transaction.ts`). This doc captures the one
pattern all new parsers must follow so the registry stays predictable.

## The `ExchangeParser` contract (`types.ts`)

```ts
interface ExchangeParser {
  id: string;                                   // stable slug, e.g. "coindcx"
  label: string;                                // shown in the import UI
  detect: (headers: string[]) => boolean;       // cheap header heuristic
  parse: (rows: Record<string, string>[]) => ParseResult;
}

interface ParseResult {
  transactions: Transaction[];
  skippedRows: number;
  warnings: string[];
}
```

- **`detect(headers)`** must be *cheap* (header inspection only) and *specific*
  enough not to steal another exchange's file. It runs in registry order
  (`index.ts` → `PARSERS`); the first parser whose `detect` returns `true`
  wins, so exchange-specific parsers are registered **ahead of** the generic
  heuristics.
- **`parse(rows)`** receives header-keyed rows (Papaparse `header: true`).
  Return every row you understood as a `Transaction`, count the rest in
  `skippedRows`, and push human-readable `warnings`.

## Shared helpers you MUST reuse (do not reinvent)

From `types.ts`:

- `safeNumber` / `safeQuantity` — tolerant number parsing (strips `,`/`$`,
  handles `"0.34SOL"`); `safeQuantity` returns an absolute magnitude.
- `safeTimestampIst(v)` — parse a bare `YYYY-MM-DD HH:mm:ss` as **IST
  (UTC+5:30)**. Use for Indian exchanges that export local time with no offset.
- `safeTimestampUtc(v)` — same, but anchors to UTC (e.g. Binance `Date(UTC)`).
  A string that already carries a `Z`/`±HH:MM` offset is trusted as-is by both.
- `exchangeSourceRef(source, timestamp, type, asset, amount)` — the
  **content-hash-stable** dedup ref. Because it hashes the identifying fields
  (not a positional row index), re-importing the same export produces the same
  `sourceRef`, so the DB dedups instead of duplicating. Always set `sourceRef`
  via this (or `contentHashRef` for manual/AI-mapped imports).
- `stableAmountKey` — the shared amount-rounding used inside the refs; you
  rarely call it directly.

From `headerMap.ts`:

- `headerMap(headers)` → map of normalized (`[^a-z0-9]` stripped, lowercased)
  header → original header.
- `col(map, ...keys)` — exact normalized lookup, first hit wins.
- `colIncludes(map, ...needles)` — substring fallback lookup.

From `pairUtils.ts`:

- `parseTradingPair("BTCINR")` → `{ base: "BTC", quote: "INR" }` (splits on
  known quote suffixes; strips `-_/.` separators).
- `quoteToFiatCurrency(quote)` → `"USD"` for USD-pegged stablecoins, `"INR"`,
  `"EUR"`, `"GBP"`, else `undefined` (i.e. the quote is a crypto leg).

## Required field mapping

| Concern            | Rule                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| `timestamp`        | epoch ms, UTC. Indian CEX exports → `safeTimestampIst`.                                          |
| `type`             | `buy` / `sell` for trades; `transfer_in` / `transfer_out` for deposits/withdrawals.              |
| `asset` / `amount` | base asset + absolute quantity moved.                                                            |
| `counterAsset/Amount` | trade quote leg (from `parseTradingPair` + the row's total/price×qty).                        |
| `fiatCurrency`     | reporting fiat (`INR` default; `USD` for USD-pegged quotes).                                      |
| `fiatValue`        | set **only** when a fiat/stablecoin quote gives a real value; otherwise leave undefined.         |
| `flags`            | `['missing_cost_basis']` when no `fiatValue`; `['possible_internal_transfer']` on transfers.     |
| `feeAmount/Asset`  | consume the fee **once** (do not also emit a separate fee row here).                              |
| **TDS (B3)**       | Capture into structured `tdsAmount` / `tdsAsset` / `tdsInr`. Do **not** only stuff it in `notes`.|
| `sourceRef`        | `exchangeSourceRef(...)` for dedup stability.                                                     |
| `source`           | the parser's slug.                                                                                |

### India TDS capture (Section 194S, 1% on VDA transfers)

Exchanges export TDS in one of two shapes; support both:

1. A single `TDS` column in INR → set `tdsAmount = tdsInr = <value>`,
   `tdsAsset = "INR"`.
2. Separate `TDS Amount` + `TDS Currency` (+ optional `TDS INR`) → set each
   field directly; if only `TDS Amount` is present and it's INR-denominated,
   mirror it into `tdsInr`.

Never duplicate TDS into a second synthetic transaction — the FY reconciliation
(`aggregateTds`) reads the structured fields off each row.

## India CEX parsers share one factory

CoinDCX, CoinSwitch, ZebPay and Mudrex all use `makeIndiaCexParser`
(`indiaCex.ts`), which implements everything above once against a shared
column-synonym table. Each exchange file is a thin wrapper supplying only
`id` / `label` / `source` and a specific `detect`. To add another Indian
exchange, write a one-line `detect` (usually keyed on its unique pair-column
header — CoinDCX `Market`, CoinSwitch `Trading Pair`, ZebPay `Symbol`, Mudrex
`Coin Pair`) and register it in `PARSERS` ahead of the generic heuristics. If a
real export uses a header not in `DEFAULT_COLUMN_SYNONYMS`, add the synonym
there rather than duplicating parse logic.

> **Assumed schemas.** The India CEX column layouts were authored from the
> WazirX export shape + common Indian-CEX conventions, not confirmed vendor
> exports. Each parser documents its assumed columns in a top-of-file comment.
> Validate against a real export and extend the synonym table as needed.

## Tests & fixtures

Golden-fixture pattern (copy an existing one, e.g. `coindcx.test.ts`):

- `__fixtures__/<exchange>/<name>.csv` — a realistic export sample.
- `__fixtures__/<exchange>/<name>.expected.json` — the normalized `Transaction[]`
  with volatile `id` and `raw` stripped (via `normalizeForSnapshot`).
- `<parser>.test.ts` — assert the golden match **plus** targeted checks for
  type mapping, IST/INR handling, fee handling, pair splitting, structured TDS
  capture, and dedup-ref stability on re-import.

Use `loadFixtureRows`, `loadExpected`, `normalizeForSnapshot` from
`__fixtures__/fixtureUtils.ts`.
