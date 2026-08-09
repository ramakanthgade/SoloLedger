# Dashboard flow aggregates

The Dashboard metric strip remains intentionally hidden. Its underlying period model is retained for future summaries and must use the following finance semantics.

## Categories

- **Money In:** reporting-currency value of external `transfer_in` rows in the inclusive period. Confirmed internal transfers are excluded.
- **Money Out:** reporting-currency value of external `transfer_out` rows in the inclusive period. Confirmed internal transfers are excluded.
- `buy`, `sell`, and `trade` are exchanges of value, not external deposits or withdrawals, and never contribute to Money In/Out.
- **Income:** retained as a separate category. It is not folded into Money In.
- **Trading Fees:** standalone `fee` rows plus inline `feeAmount`/`feeAsset` on `buy`, `sell`, and `trade` rows.
- **Realized Gains:** signed gains from cost-basis disposal records only. Fee and flow aggregation does not alter cost-basis matching.

## Valuation completeness

Every aggregate is a `ValuedAggregate` with a reporting-currency `amount`, a `status` (`complete`, `partial`, or `unavailable`), and contributor/missing-valuation counts.

A directly stored amount is used only when its asset equals the transaction reporting currency. A standalone fee row's `fiatValue` explicitly values that fee. A trade row's `fiatValue` values the trade and must not be reused for its inline fee. Crypto-denominated inline fees require a historical reporting-currency price from the existing price index at the transaction timestamp. A `feeAmount` without `feeAsset` is retained as a missing contributor; its unit is never inferred from the traded asset. Missing valuations are counted; they are never coerced to zero. If no contributor can be valued, `amount` is `null` and status is `unavailable`; if only some can be valued, `amount` is the known subtotal and status is `partial`.

Standalone and inline fee representations are deduplicated only when their asset and amount match and immutable source evidence (`sourceRef`, transaction hash, or persisted provider dedup identity) proves they represent the same fee. Similar timestamps or amounts alone are not sufficient evidence.
