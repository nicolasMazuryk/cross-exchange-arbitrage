# Bitget Actual Funding Timestamp Report

Source: `redis-dump/*.json`

Method:
- Selected trades where `opportunity.buyExchange == "bitget"` or `opportunity.sellExchange == "bitget"`.
- For Bitget as buy side, used `fundingEvents[].buyExchangeActualFundingDate`.
- For Bitget as sell side, used `fundingEvents[].sellExchangeActualFundingDate`.
- Planned time is `fundingEvents[].fundingDate`.
- Delay bucket is the whole-second delay from planned to actual time, calculated as `floor((actual - planned) / 1000)`. Exact delays are listed in the detail table.

Summary:
- JSON files scanned: 57
- Bitget-side funding events found: 28
- Events with Bitget actual funding date: 25
- Events missing Bitget actual funding date: 3

## Delay Buckets

| Delay bucket | Count |
| ---: | ---: |
| 0 seconds | 6 |
| 1 second | 11 |
| 2 seconds | 4 |
| 3 seconds | 0 |
| 4 seconds | 4 |

No Bitget actual funding event in this dump was delayed by 5 or more whole seconds.

## Bitget Actual Funding Dates

| Trade ID | Pair | Bitget side | Event | Planned funding date | Bitget actual funding date | Exact delay seconds |
| --- | --- | --- | ---: | --- | --- | ---: |
| T1300741769ljf8ly | ORCA/USDT:USDT | buy | 0 | 2026-02-17T04:00:00.000Z | 2026-02-17T04:00:02.494Z | 2.494 |
| T1343941446vjvkcg | JTO/USDT:USDT | buy | 0 | 2026-02-17T16:00:00.000Z | 2026-02-17T16:00:04.118Z | 4.118 |
| T1387146734x490ds | LA/USDT:USDT | buy | 0 | 2026-02-18T04:00:00.000Z | 2026-02-18T04:00:01.839Z | 1.839 |
| T1545552269m0sgo9 | INJ/USDT:USDT | buy | 0 | 2026-02-20T00:00:00.000Z | 2026-02-20T00:00:04.232Z | 4.232 |
| T1847945367muhbba | LA/USDT:USDT | buy | 0 | 2026-02-23T12:00:00.000Z | 2026-02-23T12:00:01.821Z | 1.821 |
| T2038741087b33loa | POWER/USDT:USDT | buy | 0 | 2026-02-25T17:00:00.000Z | 2026-02-25T17:00:00.892Z | 0.892 |
| T2063941025gdxfqa | ENSO/USDT:USDT | buy | 0 | 2026-02-26T00:00:00.000Z | 2026-02-26T00:00:04.706Z | 4.706 |
| T206395952372ht9d | FUN/USDT:USDT | sell | 0 | 2026-02-26T00:00:00.000Z | 2026-02-26T00:00:02.990Z | 2.990 |
| T2067541165ok9uav | ESP/USDT:USDT | buy | 0 | 2026-02-26T01:00:00.000Z | 2026-02-26T01:00:01.448Z | 1.448 |
| T2067541165ok9uav | ESP/USDT:USDT | buy | 1 | 2026-02-26T02:00:00.000Z | 2026-02-26T02:00:01.002Z | 1.002 |
| T2067541165ok9uav | ESP/USDT:USDT | buy | 2 | 2026-02-26T03:00:00.000Z | 2026-02-26T03:00:00.782Z | 0.782 |
| T2067546602fv4b3k | ESP/USDT:USDT | buy | 0 | 2026-02-26T01:00:00.000Z | 2026-02-26T01:00:01.448Z | 1.448 |
| T2067546602fv4b3k | ESP/USDT:USDT | buy | 1 | 2026-02-26T02:00:00.000Z | 2026-02-26T02:00:01.002Z | 1.002 |
| T2067546602fv4b3k | ESP/USDT:USDT | buy | 2 | 2026-02-26T03:00:00.000Z | 2026-02-26T03:00:00.782Z | 0.782 |
| T2110741651r6jgdf | STEEM/USDT:USDT | buy | 0 | 2026-02-26T13:00:00.000Z | 2026-02-26T13:00:00.688Z | 0.688 |
| T2110741651r6jgdf | STEEM/USDT:USDT | buy | 1 | 2026-02-26T14:00:00.000Z | 2026-02-26T14:00:01.130Z | 1.130 |
| T2135941037axc1d2 | BARD/USDT:USDT | buy | 0 | 2026-02-26T20:00:00.000Z | 2026-02-26T20:00:01.976Z | 1.976 |
| T2150372543kv0fi6 | FUN/USDT:USDT | sell | 0 | 2026-02-27T00:00:00.000Z | 2026-02-27T00:00:02.466Z | 2.466 |
| T2265541462i2z5st | ATH/USDT:USDT | buy | 0 | 2026-02-28T08:00:00.000Z | 2026-02-28T08:00:04.007Z | 4.007 |
| T2279955419b972i1 | SOPH/USDT:USDT | buy | 0 | 2026-02-28T12:00:00.000Z | 2026-02-28T12:00:02.421Z | 2.421 |
| T227997587173b31m | ALICE/USDT:USDT | buy | 0 | 2026-02-28T12:00:00.000Z | 2026-02-28T12:00:01.713Z | 1.713 |
| T24131412707t8q5y | STEEM/USDT:USDT | buy | 0 | 2026-03-02T01:00:00.000Z | 2026-03-02T01:00:00.761Z | 0.761 |
| T24131412707t8q5y | STEEM/USDT:USDT | buy | 1 | 2026-03-02T02:00:00.000Z | 2026-03-02T02:00:01.233Z | 1.233 |
| T24131412707t8q5y | STEEM/USDT:USDT | buy | 2 | 2026-03-02T03:00:00.000Z | 2026-03-02T03:00:00.659Z | 0.659 |
| T2654359618iphgpi | BARD/USDT:USDT | buy | 0 | 2026-03-04T20:00:00.000Z | 2026-03-04T20:00:01.374Z | 1.374 |

## Bitget Events With Missing Actual Funding Date

These trades involve Bitget, but the side-specific Bitget actual funding date field is empty.

| Trade ID | Pair | Bitget side | Event | Planned funding date | Empty field |
| --- | --- | --- | ---: | --- | --- |
| T127554185076qsnl | RPL/USDT:USDT | sell | 0 | 2026-02-16T21:00:00.000Z | sellExchangeActualFundingDate |
| T1909141679h1bqxr | STEEM/USDT:USDT | sell | 0 | 2026-02-24T05:00:00.000Z | sellExchangeActualFundingDate |
| T1923541771sihj6t | SKR/USDT:USDT | sell | 0 | 2026-02-24T09:00:00.000Z | sellExchangeActualFundingDate |

## Alternate Rounded-Up View

If any fractional delay should be counted in the next second bucket using `ceil((actual - planned) / 1000)`, the counts become:

| Rounded-up delay bucket | Count |
| ---: | ---: |
| 1 second | 6 |
| 2 seconds | 11 |
| 3 seconds | 4 |
| 4 seconds | 0 |
| 5 seconds | 4 |
