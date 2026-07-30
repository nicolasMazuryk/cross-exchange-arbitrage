## Instrument-lifecycle failures

Mid-session halt / suspension / delisting. This is the subtle one: a halted symbol looks identical to staleness (no ticks) but the correct response is the opposite. Staleness → resync. Halt → there's nothing to sync to; invalidate the book and remove from the arb set. If your staleness watchdog resyncs a halted symbol it'll loop forever fetching a snapshot that never resumes. Detection: venue status feed / instrument-info refresh, not the freshness watchdog. Response: HALTED state distinct from STALE.


Tick / lot / contract-multiplier change intraday. Your scaled-int representation is keyed off tick/lot. If a venue rescales (or relists at new precision), your apply math silently corrupts without any integrity check firing. Detection: instrument-definition refresh diff. Response: re-snapshot with new scaling, halt the book until reconciled.


Symbol rename / redenomination (token swaps, 1000X-style re-pegs). The stream keeps flowing under a name that no longer maps to the same economic instrument. Pure correctness landmine for the normalization layer.


4. Message normalization & instrument metadata (table stakes). A canonical internal schema, symbol mapping (BTCUSDT vs BTC-USDT vs XBTUSD), tick/lot sizes, contract multipliers and funding intervals for perps. Cross-venue price comparison is impossible without this layer, and it's the silent source of "phantom arb" when one venue quotes in contracts and another in coin.


9. Instrument metadata & cross-venue normalization [table stakes] — the single biggest gap. Symbol naming (BTCUSDT vs BTC-USDT vs BTC-USD-SWAP), tick size, lot/step size, min notional, contract multiplier (perps), price/qty precision, and listing status (active/halted/delisted) all differ per venue and change intraday. Without a canonical internal instrument map and a refresh cadence, your 30k books aren't comparable and the arb math is wrong before latency even matters. Call out: how often to re-pull instrument definitions, and how a mid-session delisting/halt should invalidate a book rather than silently freeze it.


--------

## C. Symbology & Instrument Reference Data

Instrument master — tick size, lot size, min notional, contract multiplier, settlement/quote/base currency, price/qty precision, status (active/halted/delisting).
Cross-venue symbol mapping — BTC/USDT ≠ BTCUSDT ≠ XBTUSDT; perps carry venue-specific naming.

Reference-data refresh — detect new listings, delistings, tick/lot changes, contract migrations without a redeploy.


symbol normalization
A canonical internal schema, symbol mapping (BTCUSDT vs BTC-USDT vs XBTUSD), tick/lot sizes, contract multipliers.
Symbol rename / redenomination (token swaps, 1000X-style re-pegs). The stream keeps flowing under a name that no longer maps to the same economic instrument. Pure correctness landmine for the normalization layer.
Cross-venue price comparison is impossible without this layer, and it's the silent source of "phantom arb" when one venue quotes in contracts and another in coin.
