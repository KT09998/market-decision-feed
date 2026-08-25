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

- Freshness is recomputed from source `sourceAt`, falling back only to source `updatedAt`, using `collection.evaluatedAt` after all API retries finish. `collection.startedAt` remains the run-start reference for stage gates and target-date selection; a new bridge `generatedAt` or upstream `fetchedAt` cannot make an old quote fresh.
- `market-snapshot` is the primary spot source. `market-data` is a fallback. A quote's `open` is never substituted for a missing current price, and zero is treated as unavailable rather than a trade.
- Normalized quotes retain `sourceAt`, raw `updatedAt`, and `sourceTimeBasis` (`sourceAt` or `updatedAt`) so a fallback timestamp is visible rather than silently treated as a new quote.
- Stage gates are enforced in Asia/Taipei: 23:55, 08:45, and 10:27 are warm-up runs only. `collection.startedAt` must be at or after 00:00:00, 08:50:00, or 10:30:00 respectively for a formal `READY`; a retry that finishes after the gate cannot turn a pre-gate warm-up into `READY`. A prior `READY` is reused only when its `collection.startedAt` (or legacy `generatedAt`/`asOf`) is also after that stage gate.
- In addition to HTTP/JSON retries, the collector re-fetches a bounded three-attempt source bundle when a 200 response is semantically incomplete for the requested stage (for example, 10:30 core quotes are still reference prices or the current intraday window is not ready). Freshness and stage gates are evaluated only after the final attempt.
- At 08:50, `actualOpen` is always `null`. A pre-open or reference observation may be retained separately, but it is not called the actual open.
- At 10:30, `0050`, `2330`, and `TAIEX` must each have a current-date, fresh, non-reference `last_trade`. Current-target-date `firstHour` and `intradayWindow` are required; `0050` and `TAIEX` must have both first-hour and recent-sample coverage. If the verified raw source provides no `2330` in either intraday location while top-level `2330` is fresh, the payload records `intraday.coverage.firstHour.2330` and `intraday.coverage.samples.2330` as `structurally_unavailable_from_source`, adds `intraday.2330_not_sampled_by_source` to `intraday.sourceLimitations` and `freshnessSummary.qualityReasons`, and may be `READY` only with `freshnessSummary.quality = "downgraded"`. No first-hour value is fabricated; if the source later provides `2330`, the real values are retained and the limitation disappears. `00631L` remains optional and is reported as unavailable when absent.
- `TX_DIRECTION` accepts only `continuous_nearby_direction` data and always has `contractMonth: null`.
- `TX_FRONT_MONTH` requires `explicitContract: true`, a `YYYYMM` contract month, `quoteType: explicit_contract_live`, `live: true`, source time, source name, freshness, and a reported price or bid/ask. A TAIFEX daily report or continuous-nearby quote is rejected. Bid/ask-only data stays bid/ask-only; no midpoint is invented.
- At 00:00, TSM and SOX/QQQ use `sourceAt`/`updatedAt` freshness only: up to 15 minutes is fresh, 15-30 minutes is delayed and marks `freshnessSummary.quality` as downgraded, and data older than 30 minutes is rejected while the US equity session is active. Explicit completed-session close metadata is accepted without using `fetchedAt` as evidence. The collector uses only observations that already exist when the collection completes; it does not wait for or infer a later final value.
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

- Asia/Taipei 23:55, 00:01, 00:06 for stage `0000`.
- Weekdays 08:45, 08:50, 08:55 for stage `0850`.
- Weekdays 10:27, 10:30, 10:35, 10:40 for stage `1030`.

Fallback runs exit early when a structurally valid `READY` latest already exists for the same `targetDate` and stage. Taiwan market holidays are not encoded in cron; the data gates decide whether an observation is acceptable.

## Close stage

The close stage is an independent, public-data-only collector. It adds:

- scripts/collect-close.mjs: close-stage collector and self-test.
- .github/workflows/collect-close.yml: weekday fallback schedule and manual workflow_dispatch with test_mode=true by default.
- latest_close.json: formal close output; it is written only by a non-test READY run.
- status_close.json: the latest close collection attempt, including COLLECTING, DEGRADED, ERROR, and test evidence.

The workflow runs at Asia/Taipei 13:35, 13:40, 13:45, and 13:50 (UTC 05:35, 05:40, 05:45, 05:50). A run started before 13:35 can never become formal READY, even if a retry crosses the gate. A close READY requires current target-date 0050, 2330, and TAIEX with close, open, high, low, and previousClose, non-reference last_trade semantics, source time on the target date at or after 13:20, and source-based freshness no older than 20 minutes at collection.evaluatedAt. 00631L is optional.

The payload records closeVsOpenPercent, closeLocationPercent from 0 to 100, closePosition (near_low, middle, or near_high), and sessionStructure counts plus synchronized weak/strong close flags. First-hour and recent retention samples are auxiliary only. If the source does not sample 2330 intraday, the payload records intraday.2330_not_sampled_by_source and downgrades quality without blocking close READY; no value is fabricated.

Freshness uses only sourceAt or updatedAt; bridge fetchedAt and generatedAt cannot refresh an old quote. The close collector uses only HTTP GET requests to the same three public endpoints listed above, keeps retry/idempotence behavior, scans sensitive keys, and enforces the 64 KiB payload cap.

Run the close self-test locally with: node scripts/collect-close.mjs --self-test

To validate API access without changing latest_close.json, manually dispatch Collect market close bridge with test_mode=true. The run writes only status_close.json and auditable workflow evidence.

