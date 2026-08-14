#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_SITE = "https://tw-stock-dashboard.netlify.app";
const ENDPOINTS = {
  health: `${SOURCE_SITE}/.netlify/functions/market-data-health`,
  marketData: `${SOURCE_SITE}/.netlify/functions/market-data`,
  snapshot: `${SOURCE_SITE}/.netlify/functions/market-snapshot`,
};
const STAGES = new Set(["0000", "0850", "1030"]);
const REQUIRED_KEYS = [
  "schemaVersion",
  "stage",
  "status",
  "generatedAt",
  "targetDate",
  "sourceSite",
  "marketHealth",
  "spot",
  "overnight",
  "futures",
  "intraday",
  "freshnessSummary",
  "missingRequired",
  "errors",
];
const STATUS_VALUES = new Set(["READY", "COLLECTING", "DEGRADED", "ERROR"]);
const SENSITIVE_KEYS = new Set([
  "position_state",
  "fill",
  "capital",
  "token",
  "secret",
  "telegram",
  "api_key",
]);
const MAX_PAYLOAD_BYTES = 64 * 1024;
const CORE_SPOT = ["0050", "2330", "TAIEX"];
const SPOT_SYMBOLS = [...CORE_SPOT, "00631L"];
const OVERNIGHT_SYMBOLS = ["TSM", "SOX", "QQQ_NASDAQ", "NVDA", "MU", "USD_TWD", "VIX"];

function parseArgs(argv) {
  const options = { stage: null, testMode: false, selfTest: false, force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--stage") options.stage = argv[++index];
    else if (value === "--test-mode") options.testMode = true;
    else if (value === "--self-test") options.selfTest = true;
    else if (value === "--force") options.force = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return options;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positiveNumber(value) {
  const number = finiteNumber(value);
  return number !== null && number > 0 ? number : null;
}

function compactArray(value, limit = 1) {
  return Array.isArray(value) ? value.map(positiveNumber).filter((item) => item !== null).slice(0, limit) : [];
}

function taipeiParts(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.map(({ type, value }) => [type, value]));
}

function dateInTaipei(date) {
  const parts = taipeiParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addUtcDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function targetDateFor(stage, now) {
  const parts = taipeiParts(now);
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  return stage === "0000" && Number(parts.hour) >= 20 ? addUtcDays(today, 1) : today;
}

function sourceTimestamp(value) {
  return value?.freshness?.sourceAt ?? value?.sourceAt ?? value?.updatedAt ?? null;
}

function assessFreshness(sourceAt, now, maxAgeSeconds) {
  if (!sourceAt) return { status: "missing", sourceAt: null, ageSeconds: null, maxAgeSeconds, basis: "sourceAt_or_updatedAt" };
  const sourceMs = Date.parse(sourceAt);
  if (!Number.isFinite(sourceMs)) return { status: "invalid", sourceAt, ageSeconds: null, maxAgeSeconds, basis: "sourceAt_or_updatedAt" };
  const ageSeconds = Math.round((now.getTime() - sourceMs) / 1000);
  const status = ageSeconds < -300 ? "invalid" : ageSeconds <= maxAgeSeconds ? "fresh" : "stale";
  return { status, sourceAt: new Date(sourceMs).toISOString(), ageSeconds, maxAgeSeconds, basis: "sourceAt_or_updatedAt" };
}

function unavailable(reason) {
  return {
    available: false,
    price: null,
    bid: null,
    ask: null,
    sourceAt: null,
    source: null,
    freshness: { status: "missing", sourceAt: null, ageSeconds: null, maxAgeSeconds: null, basis: "sourceAt_or_updatedAt" },
    reason,
  };
}

function quoteMap(marketData) {
  const map = new Map();
  for (const quote of Array.isArray(marketData?.quotes) ? marketData.quotes : []) {
    if (typeof quote?.symbol === "string") map.set(quote.symbol, quote);
  }
  return map;
}

function normalizeSpot(symbol, snapshot, marketQuotes, stage, now) {
  const primary = snapshot?.quotes?.[symbol];
  const fallback = marketQuotes.get(symbol);
  const primaryIsTrade = isObject(primary) && positiveNumber(primary.price) !== null && primary.priceKind === "last_trade" && primary.isReferencePrice !== true;
  const fallbackIsTrade = isObject(fallback) && positiveNumber(fallback.close) !== null && fallback.priceKind === "last_trade" && fallback.isReferencePrice !== true;
  const selected = primaryIsTrade ? primary : fallbackIsTrade ? fallback : isObject(primary) ? primary : fallback;
  if (!selected) return unavailable("symbol_absent_from_sources");

  const isSnapshot = selected === primary;
  const rawPrice = isSnapshot ? positiveNumber(selected.price) : positiveNumber(selected.close);
  const priceKind = selected.priceKind ?? (rawPrice !== null ? "unspecified_quote" : "unavailable");
  const isActualTrade = rawPrice !== null && priceKind === "last_trade" && selected.isReferencePrice !== true;
  const price = isActualTrade ? rawPrice : null;
  const indicativePrice = stage === "0850" && rawPrice !== null && !isActualTrade ? rawPrice : null;
  const sourceAt = sourceTimestamp(selected);
  const maxAgeSeconds = stage === "1030" ? 600 : stage === "0850" ? 1_200 : 129_600;
  const freshness = assessFreshness(sourceAt, now, maxAgeSeconds);
  const bid = compactArray(selected.bestBid)[0] ?? null;
  const ask = compactArray(selected.bestAsk)[0] ?? null;

  return {
    available: price !== null || indicativePrice !== null || bid !== null || ask !== null,
    price,
    indicativePrice,
    previousClose: positiveNumber(selected.previousClose),
    changePercent: finiteNumber(selected.changePercent ?? selected.change),
    actualOpen: stage === "0850" ? null : positiveNumber(selected.open),
    high: positiveNumber(selected.high),
    low: positiveNumber(selected.low),
    bid,
    ask,
    priceKind,
    isReferencePrice: selected.isReferencePrice === true,
    sourceAt: freshness.sourceAt,
    source: selected.source ?? (isSnapshot ? snapshot.source : null),
    sourceSymbol: selected.sourceChannel ?? selected.sourceSymbol ?? null,
    freshness,
  };
}

function normalizeOvernight(symbol, marketQuotes, now) {
  const candidates = symbol === "QQQ_NASDAQ" ? ["QQQ", "NASDAQ", "IXIC"] : symbol === "USD_TWD" ? ["USD_TWD", "USDTWD", "TWD=X"] : [symbol];
  const quote = candidates.map((candidate) => marketQuotes.get(candidate)).find(Boolean);
  if (!quote) return unavailable("symbol_absent_from_market_data");
  const price = positiveNumber(quote.close ?? quote.price);
  const sourceAt = sourceTimestamp(quote);
  const freshness = assessFreshness(sourceAt, now, 129_600);
  return {
    available: price !== null,
    price,
    changePercent: finiteNumber(quote.changePercent ?? quote.change),
    sourceAt: freshness.sourceAt,
    source: quote.source ?? null,
    sourceSymbol: quote.sourceSymbol ?? null,
    quoteType: "regular_market_quote",
    freshness,
  };
}

function normalizeDirection(marketQuotes, now) {
  const quote = marketQuotes.get("TX_DIRECTION") ?? marketQuotes.get("TX_NIGHT");
  if (!quote) return { ...unavailable("continuous_nearby_absent"), quoteType: "continuous_nearby_direction", contractMonth: null };
  const validClass = quote.quoteType === "continuous_nearby_direction" && quote.explicitContract !== true && !quote.contractMonth;
  if (!validClass) return { ...unavailable("source_is_not_continuous_nearby_direction"), quoteType: "continuous_nearby_direction", contractMonth: null };
  const freshness = assessFreshness(sourceTimestamp(quote), now, 1_800);
  return {
    available: positiveNumber(quote.close ?? quote.price) !== null,
    price: positiveNumber(quote.close ?? quote.price),
    changePercent: finiteNumber(quote.changePercent ?? quote.change),
    sourceAt: freshness.sourceAt,
    source: quote.source ?? null,
    sourceSymbol: quote.sourceSymbol ?? null,
    quoteType: "continuous_nearby_direction",
    contractMonth: null,
    freshness,
  };
}

function validateFrontMonthQuote(quote, now = new Date()) {
  if (!quote) return { valid: false, reason: "explicit_front_month_absent" };
  const sourceText = `${quote.source ?? ""} ${quote.sourceSymbol ?? ""} ${quote.quoteType ?? ""}`.toLowerCase();
  if (sourceText.includes("dailymarketreport") || sourceText.includes("daily market report")) return { valid: false, reason: "daily_report_is_not_live_front_month" };
  if (quote.explicitContract !== true || !/^\d{6}$/.test(String(quote.contractMonth ?? ""))) return { valid: false, reason: "missing_explicit_contract_month" };
  if (quote.quoteType !== "explicit_contract_live" || quote.live !== true) return { valid: false, reason: "quote_is_not_explicit_contract_live" };
  if (!quote.source || quote.quoteType === "continuous_nearby_direction") return { valid: false, reason: "continuous_or_unsourced_quote_rejected" };
  const freshness = assessFreshness(sourceTimestamp(quote), now, 1_800);
  if (!freshness.sourceAt) return { valid: false, reason: "missing_source_timestamp" };
  const price = positiveNumber(quote.last ?? quote.close ?? quote.price);
  const bid = compactArray(quote.bestBid ?? [quote.bid])[0] ?? null;
  const ask = compactArray(quote.bestAsk ?? [quote.ask])[0] ?? null;
  if (price === null && bid === null && ask === null) return { valid: false, reason: "missing_live_price_and_bid_ask" };
  return { valid: true, price, bid, ask, freshness };
}

function normalizeFrontMonth(marketQuotes, now) {
  const quote = marketQuotes.get("TX_FRONT_MONTH");
  const validation = validateFrontMonthQuote(quote, now);
  if (!validation.valid) {
    return {
      ...unavailable(validation.reason),
      quoteType: "explicit_contract_live",
      contractMonth: null,
      explicitContract: false,
    };
  }
  return {
    available: true,
    price: validation.price,
    bid: validation.bid,
    ask: validation.ask,
    priceBasis: validation.price !== null ? "last_or_reported_price" : "bid_ask_only_no_midpoint",
    changePercent: finiteNumber(quote.changePercent ?? quote.change),
    contractMonth: String(quote.contractMonth),
    explicitContract: true,
    live: true,
    quoteType: "explicit_contract_live",
    sourceAt: validation.freshness.sourceAt,
    source: quote.source,
    sourceSymbol: quote.sourceSymbol ?? null,
    freshness: validation.freshness,
  };
}

function compactFirstHour(firstHour) {
  if (!isObject(firstHour)) return null;
  const symbols = {};
  for (const symbol of SPOT_SYMBOLS) {
    const value = firstHour.symbols?.[symbol];
    if (!value) continue;
    symbols[symbol] = {
      open: positiveNumber(value.open),
      high: positiveNumber(value.high),
      low: positiveNumber(value.low),
      last: positiveNumber(value.last),
      rangePercent: finiteNumber(value.rangePercent),
      precision: value.precision ?? null,
    };
  }
  return { frozenAt: firstHour.frozenAt ?? null, through: firstHour.through ?? null, symbols };
}

function compactSamples(samples) {
  return (Array.isArray(samples) ? samples : []).slice(-6).map((sample) => {
    const quotes = {};
    for (const symbol of SPOT_SYMBOLS) {
      const quote = sample?.quotes?.[symbol];
      if (!quote) continue;
      quotes[symbol] = {
        price: positiveNumber(quote.price),
        changePercent: finiteNumber(quote.changePercent),
        sourceAt: quote.sourceAt ?? null,
        freshness: quote.freshness ?? null,
      };
    }
    return { at: sample.at ?? null, quotes };
  });
}

function normalizeIntraday(snapshot, stage) {
  if (stage !== "1030") return { firstHour: null, intradayWindow: null, samples: [] };
  const window = snapshot?.intradayWindow;
  if (!isObject(window)) return { firstHour: null, intradayWindow: null, samples: [] };
  const trendSymbols = {};
  for (const symbol of SPOT_SYMBOLS) {
    const trend = window.trend?.symbols?.[symbol];
    if (trend) trendSymbols[symbol] = trend;
  }
  return {
    firstHour: compactFirstHour(window.firstHour),
    intradayWindow: {
      tradingDate: window.tradingDate ?? null,
      updatedAt: window.updatedAt ?? null,
      cadenceSeconds: finiteNumber(window.cadenceSeconds),
      retentionMinutes: finiteNumber(window.retentionMinutes),
      sampleCount: Array.isArray(window.samples) ? window.samples.length : 0,
      trend: isObject(window.trend) ? { asOf: window.trend.asOf ?? null, sampleCount: finiteNumber(window.trend.sampleCount), symbols: trendSymbols } : null,
    },
    samples: compactSamples(window.samples),
  };
}

function summarizeHealth(health) {
  if (!isObject(health)) return { available: false, status: "unavailable", checkedAt: null, components: {} };
  const components = {};
  for (const name of ["marketData", "marketSnapshot", "intradaySampler"]) {
    const component = health.components?.[name];
    if (!component) continue;
    components[name] = {
      ok: component.ok === true,
      httpStatus: finiteNumber(component.httpStatus),
      mode: component.mode ?? null,
      sourceAt: component.lastSampleAt ?? null,
      sampleCount: finiteNumber(component.sampleCount),
      firstHourReady: typeof component.firstHourReady === "boolean" ? component.firstHourReady : null,
    };
  }
  return { available: true, ok: health.ok === true, status: health.status ?? "unknown", checkedAt: health.checkedAt ?? null, session: health.session ?? null, components };
}

function collectFreshnessRecords(value, records = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectFreshnessRecords(item, records);
  } else if (isObject(value)) {
    if (isObject(value.freshness) && typeof value.freshness.status === "string") records.push(value.freshness);
    for (const [key, item] of Object.entries(value)) if (key !== "freshness") collectFreshnessRecords(item, records);
  }
  return records;
}

function freshnessSummary(data, testMode) {
  const records = collectFreshnessRecords({ spot: data.spot, overnight: data.overnight, futures: data.futures });
  const counts = { fresh: 0, stale: 0, missing: 0, invalid: 0 };
  const timestamps = [];
  for (const record of records) {
    counts[record.status] = (counts[record.status] ?? 0) + 1;
    if (record.sourceAt) timestamps.push(record.sourceAt);
  }
  timestamps.sort();
  return {
    basis: "sourceAt_or_updatedAt_only",
    fetchedAtIsFreshnessEvidence: false,
    testMode,
    counts,
    oldestSourceAt: timestamps[0] ?? null,
    newestSourceAt: timestamps.at(-1) ?? null,
  };
}

function sourceDateMatches(value, targetDate) {
  const sourceAt = value?.freshness?.sourceAt;
  return sourceAt ? dateInTaipei(new Date(sourceAt)) === targetDate : false;
}

function determineStatus(stage, data, fetchErrors, testMode) {
  const missingRequired = [];
  const missingOptional = [];
  if (!data.marketHealth.available) missingOptional.push("marketHealth");

  if (stage === "1030") {
    for (const symbol of CORE_SPOT) {
      const quote = data.spot[symbol];
      if (quote?.price === null || quote?.priceKind !== "last_trade" || quote?.freshness?.status !== "fresh" || !sourceDateMatches(quote, data.targetDate)) {
        missingRequired.push(`spot.${symbol}.current_last_trade`);
      }
    }
    if (!data.spot["00631L"]?.available) missingOptional.push("spot.00631L");
    if (!data.intraday.firstHour) missingOptional.push("intraday.firstHour");
    if (!data.intraday.intradayWindow) missingOptional.push("intraday.intradayWindow");
  } else if (stage === "0850") {
    for (const symbol of CORE_SPOT) {
      const quote = data.spot[symbol];
      const hasObservation = quote?.available && quote?.freshness?.status === "fresh" && sourceDateMatches(quote, data.targetDate);
      if (!hasObservation) missingRequired.push(`spot.${symbol}.current_preopen_observation`);
      if (quote?.actualOpen !== null) missingRequired.push(`spot.${symbol}.actualOpen_must_be_null_at_0850`);
    }
  } else {
    if (!data.overnight.TSM?.available) missingRequired.push("overnight.TSM");
    if (!data.overnight.SOX?.available && !data.overnight.QQQ_NASDAQ?.available) missingRequired.push("overnight.SOX_or_QQQ_NASDAQ");
  }

  if (!data.futures.TX_DIRECTION.available) missingOptional.push("futures.TX_DIRECTION");
  if (!data.futures.TX_FRONT_MONTH.available) missingOptional.push("futures.TX_FRONT_MONTH");

  let status;
  if (fetchErrors.length >= 3) status = "ERROR";
  else if (testMode) status = fetchErrors.length ? "DEGRADED" : "COLLECTING";
  else if (missingRequired.length === 0) status = "READY";
  else status = "DEGRADED";
  return { status, missingRequired, missingOptional };
}

function findSensitiveKeys(value, pathParts = [], found = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findSensitiveKeys(item, [...pathParts, String(index)], found));
  } else if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (SENSITIVE_KEYS.has(key.toLowerCase())) found.push([...pathParts, key].join("."));
      findSensitiveKeys(item, [...pathParts, key], found);
    }
  }
  return found;
}

function validatePayload(payload) {
  const failures = [];
  for (const key of REQUIRED_KEYS) if (!(key in payload)) failures.push(`missing top-level key: ${key}`);
  if (!STAGES.has(payload.stage)) failures.push(`invalid stage: ${payload.stage}`);
  if (!STATUS_VALUES.has(payload.status)) failures.push(`invalid status: ${payload.status}`);
  const sensitive = findSensitiveKeys(payload);
  if (sensitive.length) failures.push(`sensitive keys found: ${sensitive.join(", ")}`);
  const bytes = Buffer.byteLength(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
  if (bytes > MAX_PAYLOAD_BYTES) failures.push(`payload ${bytes} exceeds ${MAX_PAYLOAD_BYTES} bytes`);
  return { failures, bytes };
}

async function fetchJson(name, url, options = {}) {
  const delays = options.delays ?? [0, 15_000, 30_000];
  const timeoutMs = options.timeoutMs ?? 25_000;
  let lastError;
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt] > 0) await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    try {
      const response = await fetch(url, { headers: { accept: "application/json", "user-agent": "market-decision-feed/1.0" }, signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      const data = JSON.parse(text);
      console.log(`API ${name} ok status=${response.status} bytes=${Buffer.byteLength(text, "utf8")} attempt=${attempt + 1}`);
      return { data, error: null };
    } catch (error) {
      lastError = error;
      console.warn(`API ${name} failed attempt=${attempt + 1}/${delays.length}: ${error.message}`);
    }
  }
  return { data: null, error: `${name}: ${lastError?.message ?? "unknown error"}` };
}

async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function isReasonableReady(payload, stage, targetDate) {
  return payload?.status === "READY" && payload?.stage === stage && payload?.targetDate === targetDate && REQUIRED_KEYS.every((key) => key in payload);
}

async function buildPayload(stage, testMode, now = new Date()) {
  const results = await Promise.all(Object.entries(ENDPOINTS).map(async ([name, url]) => [name, await fetchJson(name, url)]));
  const responses = Object.fromEntries(results);
  const fetchErrors = Object.values(responses).map((result) => result.error).filter(Boolean);
  const marketData = responses.marketData.data;
  const snapshot = responses.snapshot.data;
  const quotes = quoteMap(marketData);
  const targetDate = targetDateFor(stage, now);

  const data = {
    schemaVersion: "1.0.0",
    stage,
    status: "COLLECTING",
    generatedAt: now.toISOString(),
    targetDate,
    sourceSite: { baseUrl: SOURCE_SITE, endpoints: ENDPOINTS },
    marketHealth: summarizeHealth(responses.health.data),
    spot: Object.fromEntries(SPOT_SYMBOLS.map((symbol) => [symbol, normalizeSpot(symbol, snapshot, quotes, stage, now)])),
    overnight: Object.fromEntries(OVERNIGHT_SYMBOLS.map((symbol) => [symbol, normalizeOvernight(symbol, quotes, now)])),
    futures: { TX_DIRECTION: normalizeDirection(quotes, now), TX_FRONT_MONTH: normalizeFrontMonth(quotes, now) },
    intraday: normalizeIntraday(snapshot, stage),
    freshnessSummary: null,
    missingRequired: [],
    missingOptional: [],
    errors: fetchErrors.map((message) => ({ source: "public_api", message })),
    collection: { testMode, latestUpdated: false, sourceSchemas: { health: responses.health.data?.status ?? null, marketData: marketData?.schemaVersion ?? null, snapshot: snapshot?.schemaVersion ?? null } },
  };
  data.freshnessSummary = freshnessSummary(data, testMode);
  const decision = determineStatus(stage, data, fetchErrors, testMode);
  data.status = decision.status;
  data.missingRequired = decision.missingRequired;
  data.missingOptional = decision.missingOptional;
  return data;
}

async function writeCollection(payload, testMode) {
  const statusPath = path.join(ROOT, `status_${payload.stage}.json`);
  const latestPath = path.join(ROOT, `latest_${payload.stage}.json`);
  const serializedStatus = `${JSON.stringify(payload, null, 2)}\n`;
  const validation = validatePayload(payload);
  if (validation.failures.length) throw new Error(`Output validation failed: ${validation.failures.join("; ")}`);
  await writeFile(statusPath, serializedStatus, "utf8");

  let latestUpdated = false;
  if (!testMode) {
    const existing = await readJsonIfPresent(latestPath);
    if (payload.status === "READY" || existing?.status !== "READY") {
      const latest = structuredClone(payload);
      latest.collection.latestUpdated = true;
      const latestValidation = validatePayload(latest);
      if (latestValidation.failures.length) throw new Error(`Latest validation failed: ${latestValidation.failures.join("; ")}`);
      await writeFile(latestPath, `${JSON.stringify(latest, null, 2)}\n`, "utf8");
      latestUpdated = true;
    }
  }
  console.log(`RESULT stage=${payload.stage} status=${payload.status} targetDate=${payload.targetDate} testMode=${testMode} latestUpdated=${latestUpdated} statusBytes=${validation.bytes}`);
}

async function runSelfTest() {
  const failures = [];
  const now = new Date("2026-08-15T02:30:00.000Z");
  if (assessFreshness("2020-01-01T00:00:00.000Z", now, 600).status !== "stale") failures.push("old sourceAt became fresh");
  if (assessFreshness(null, now, 600).status !== "missing") failures.push("missing sourceAt did not stay missing");

  const nearby = { quoteType: "continuous_nearby_direction", explicitContract: false, contractMonth: null, live: true, close: 20000, source: "continuous nearby", updatedAt: now.toISOString() };
  if (validateFrontMonthQuote(nearby, now).valid) failures.push("continuous nearby became TX_FRONT_MONTH");
  const daily = { quoteType: "explicit_contract_live", explicitContract: true, contractMonth: "202608", live: true, close: 20000, source: "TAIFEX DailyMarketReport", updatedAt: now.toISOString() };
  if (validateFrontMonthQuote(daily, now).valid) failures.push("daily report became TX_FRONT_MONTH");
  const bidAskOnly = { quoteType: "explicit_contract_live", explicitContract: true, contractMonth: "202608", live: true, close: null, bestBid: [19999], bestAsk: [20001], source: "live explicit contract", updatedAt: now.toISOString() };
  const bidAskResult = validateFrontMonthQuote(bidAskOnly, now);
  if (!bidAskResult.valid || bidAskResult.price !== null || bidAskResult.bid !== 19999 || bidAskResult.ask !== 20001) failures.push("bid/ask-only quote was rejected or midpoint was fabricated");

  const templateFiles = [...["0000", "0850", "1030"].flatMap((stage) => [`latest_${stage}.json`, `status_${stage}.json`])];
  for (const fileName of templateFiles) {
    const payload = await readJsonIfPresent(path.join(ROOT, fileName));
    if (!payload) {
      failures.push(`${fileName} missing`);
      continue;
    }
    const validation = validatePayload(payload);
    failures.push(...validation.failures.map((failure) => `${fileName}: ${failure}`));
  }

  const sensitiveFixture = { safe: true, api_key: "must-be-detected" };
  if (findSensitiveKeys(sensitiveFixture).length !== 1) failures.push("sensitive-key scanner failed");
  if (failures.length) throw new Error(`Self-test failed:\n- ${failures.join("\n- ")}`);
  console.log(`SELF_TEST_OK templates=${templateFiles.length} maxPayloadBytes=${MAX_PAYLOAD_BYTES}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) {
    await runSelfTest();
    return;
  }
  if (!STAGES.has(options.stage)) throw new Error("--stage must be one of 0000, 0850, or 1030");
  const targetDate = targetDateFor(options.stage, new Date());
  const latestPath = path.join(ROOT, `latest_${options.stage}.json`);
  if (!options.testMode && !options.force && isReasonableReady(await readJsonIfPresent(latestPath), options.stage, targetDate)) {
    console.log(`SKIP stage=${options.stage} targetDate=${targetDate} reason=reasonable_ready_exists`);
    return;
  }
  const payload = await buildPayload(options.stage, options.testMode);
  await writeCollection(payload, options.testMode);
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
