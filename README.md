# Market Decision Feed

Small public-data bridge that reads three existing public endpoints from `tw-stock-dashboard` and publishes compact, stage-specific JSON files in this repository.

This repository does **not** modify or deploy `tw-stock-dashboard`. It sends only HTTP `GET` requests to:

- `https://tw-stock-dashboard.netlify.app/.netlify/functions/market-data-health`
- `https://tw-stock-dashboard.netlify.app/.netlify/functions/market-data`
- `https://tw-stock-dashboard.netlify.app/.netlify/functions/market-snapshot`

The output is public market data only. Do not add holdings, executions, account balances, credentials, notification configuration, private decisions, or other personal data.

## Published files

- `latest_0000.json`, `latest_0850.json`, `latest_1030.json`: last accepted result for each stage.
- `status_0000.json`, `status_0850.json`, `status_1030.json`: result of the most recent non-test collection attempt.

An incomplete `COLLECTING`, `DEGRADED`, or `ERROR` attempt never replaces an existing `READY` latest file. It is written to the matching status file instead. If no `READY` file exists yet, the latest file may remain an initial `COLLECTING` template or advance to another non-ready state. Consumers must require both `status === "READY"` and the expected `targetDate`; a previous date is stale even if its status is `READY`.

Each payload includes at least:

`schemaVersion`, `stage`, `status`, `generatedAt`, `targetDate`, `sourceSite`, `marketHealth`, `spot`, `overnight`, `futures`, `intraday`, `freshnessSummary`, `missingRequired`, and `errors`.

Payloads are capped at 64 KiB. The 10:30 output keeps only a compact first-hour summary, window metadata/trend, and the six most recent samples. A raw long history is never copied.

## Freshness and price rules

- Freshness is recomputed from source `sourceAt`, falling back only to source `updatedAt`. A new bridge `generatedAt` or upstream `fetchedAt` cannot make an old quote fresh.
- `market-snapshot` is the primary spot source. `market-data` is a fallback. A quote's `open` is never substituted for a missing current price, and zero is treated as unavailable rather than a trade.
- At 08:50, `actualOpen` is always `null`. A pre-open or reference observation may be retained separately, but it is not called the actual open.
- Stage gates are enforced in Asia/Taipei: 23:57, 08:47, and 10:27 are warm-up runs only; `READY` cannot be generated before 00:00:00, 08:50:00, or 10:30:00 respectively. A prior `READY` is reused only when its `generatedAt`/`asOf` is also after that stage gate.
- At 10:30, `0050`, `2330`, and `TAIEX` must each have a current-date, fresh, non-reference `last_trade`; current-target-date `firstHour` and `intradayWindow` coverage for all three core symbols is also required before the result can be `READY`. Missing raw `2330` coverage is reported in `missingRequired`; no first-hour values are fabricated. `00631L` remains optional and is reported as unavailable when absent.
- `TX_DIRECTION` accepts only `continuous_nearby_direction` data and always has `contractMonth: null`.
- `TX_FRONT_MONTH` requires `explicitContract: true`, a `YYYYMM` contract month, `quoteType: explicit_contract_live`, `live: true`, source time, source name, freshness, and a reported price or bid/ask. A TAIFEX daily report or continuous-nearby quote is rejected. Bid/ask-only data stays bid/ask-only; no midpoint is invented.
- At 00:00, TSM and SOX/QQQ use `sourceAt`/`updatedAt` freshness only: up to 15 minutes is fresh, 15-30 minutes is delayed and marks `freshnessSummary.quality` as downgraded, and data older than 30 minutes is rejected while the US equity session is active. Explicit completed-session close metadata is accepted without using `fetchedAt` as evidence. The collector uses only observations that already exist at collection time; it does not wait for or infer a later final value.
- Source times with only a few seconds of clock skew are clamped to `ageSeconds: 0`; larger future timestamps are invalid.

Statuses are `READY`, `COLLECTING`, `DEGRADED`, or `ERROR`. `test_mode` can validate API access, schema handling, freshness, futures classification, and JSON generation, but it can never produce a formal `READY` result or update a latest file. Its status file is committed as auditable test evidence.

## Run locally

Node.js 22 or newer is sufficient; there are no package dependencies.

```bash
node scripts/collect-market.mjs --self-test
node scripts/collect-market.mjs --stage 1030 --test-mode
```

The collector uses a 25-second HTTP timeout and up to three attempts, waiting 15 seconds and 30 seconds before the second and third attempts.

## GitHub Actions schedule

The workflow also supports manual dispatch with a selectable stage and `test_mode`.

Scheduled UTC cron entries correspond to:

- Asia/Taipei 23:57, 00:03, 00:08 for stage `0000`.
- Weekdays 08:47, 08:52, 08:57 for stage `0850`.
- Weekdays 10:27, 10:32, 10:37, 10:42 for stage `1030`.

Fallback runs exit early when a structurally valid `READY` latest already exists for the same `targetDate` and stage. Taiwan market holidays are not encoded in cron; the data gates decide whether an observation is acceptable.
