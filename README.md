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
- At 10:30, `0050`, `2330`, and `TAIEX` must each have a current-date, fresh, non-reference `last_trade` before the result can be `READY`. `00631L`, `firstHour`, and `intradayWindow` are retained when present but are optional.
- `TX_DIRECTION` accepts only `continuous_nearby_direction` data and always has `contractMonth: null`.
- `TX_FRONT_MONTH` requires `explicitContract: true`, a `YYYYMM` contract month, `quoteType: explicit_contract_live`, `live: true`, source time, source name, freshness, and a reported price or bid/ask. A TAIFEX daily report or continuous-nearby quote is rejected. Bid/ask-only data stays bid/ask-only; no midpoint is invented.
- At 00:00, the collector uses only observations that already exist at collection time. It does not wait for or infer a later final value.

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
