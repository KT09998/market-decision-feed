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
const STAGE_NOT_BEFORE = { "0000": "00:00:00", "0850": "08:50:00", "1030": "10:30:00" };
const CLOCK_SKEW_TOLERANCE_SECONDS = 5;
const MIDNIGHT_FRESH_SECONDS = 15 * 60;
const MIDNIGHT_DELAYED_SECONDS = 30 * 60;

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

function stageNotBefore(stage, targetDate) {
  const time = STAGE_NOT_BEFORE[stage];
  return time && targetDate ? new Date(targetDate + "T" + time + "+08:00") : null;
}

function stageWindowOpen(stage, targetDate, at) {
  const gate = stageNotBefore(stage, targetDate);
  return gate !== null && Number.isFinite(gate.getTime()) && at instanceof Date && Number.isFinite(at.getTime()) && at.getTime() >= gate.getTime();
}

function sourceTimestamp(value) {
  return value?.freshness?.sourceAt ?? value?.sourceAt ?? value?.updatedAt ?? null;
}


function assessFreshness(sourceAt, now, maxAgeSeconds) {
  if (!sourceAt) return { status: "missing", sourceAt: null, ageSeconds: null, maxAgeSeconds, basis: "sourceAt_or_updatedAt" };
  const sourceMs = Date.parse(sourceAt);
  if (!Number.isFinite(sourceMs)) return { status: "invalid", sourceAt, ageSeconds: null, maxAgeSeconds, basis: "sourceAt_or_updatedAt" };
  const rawAgeSeconds = Math.round((now.getTime() - sourceMs) / 1000);
  const clockSkewClamped = rawAgeSeconds < 0 && rawAgeSeconds >= -CLOCK_SKEW_TOLERANCE_SECONDS;
  const ageSeconds = clockSkewClamped ? 0 : rawAgeSeconds < 0 ? null : rawAgeSeconds;
  const status = rawAgeSeconds < -CLOCK_SKEW_TOLERANCE_SECONDS ? "invalid" : ageSeconds <= maxAgeSeconds ? "fresh" : "stale";
  return { status, sourceAt: new Date(sourceMs).toISOString(), ageSeconds, rawAgeSeconds, clockSkewClamped, maxAgeSeconds, basis: "sourceAt_or_updatedAt" };
}

function payloadCollectionStartedAt(payload, fallback = null) {
  const value = payload?.collection?.startedAt ?? fallback ?? payload?.generatedAt ?? payload?.asOf;
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date : null;
}

function isCompletedSessionQuote(value) {
  if (value?.completedSession === true || value?.completed_session === true) return true;
  const quoteType = String(value?.quoteType ?? "").toLowerCase();
  if (["official_close", "completed_session_close", "regular_market_close"].includes(quoteType)) return true;
  const states = [value?.session, value?.sessionStatus, value?.marketState, value?.marketStatus]
    .map((state) => String(state ?? "").toLowerCase());
  return states.some((state) => ["closed", "completed", "complete"].includes(state));
}

function isUsEquityActive(now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now).map(({ type, value }) => [type, value]));
  const weekday = parts.weekday;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return !["Sat", "Sun"].includes(weekday) && minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

function assessMidnightFreshness(value, now) {
  const base = assessFreshness(sourceTimestamp(value), now, MIDNIGHT_FRESH_SECONDS);
  const activeSession = isUsEquityActive(now);
  if (base.status === "missing" || base.status === "invalid") {
    return { ...base, classification: base.status, quality: "blocked", activeSession };
  }
  if (isCompletedSessionQuote(value)) {
    return { ...base, status: "completed-session", classification: "completed-session", quality: "standard", activeSession: false };
  }
  const ageSeconds = base.rawAgeSeconds ?? base.ageSeconds;
  if (ageSeconds <= MIDNIGHT_FRESH_SECONDS) {
    return { ...base, status: "fresh", classification: "fresh", quality: "standard", activeSession };
  }
  if (ageSeconds <= MIDNIGHT_DELAYED_SECONDS) {
    return { ...base, status: "delayed", classification: "delayed", quality: "downgraded", activeSession };
  }
  return { ...base, status: "stale", classification: "stale", quality: activeSession ? "blocked" : "downgraded", activeSession };
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

function normalizeSpot(symbol, snapshot, marketQuotes, stage, evaluatedAt) {
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
  const freshness = assessFreshness(sourceAt, evaluatedAt, maxAgeSeconds);
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


function normalizeOvernight(symbol, marketQuotes, evaluatedAt) {
  const candidates = symbol === "QQQ_NASDAQ" ? ["QQQ", "NASDAQ", "IXIC"] : symbol === "USD_TWD" ? ["USD_TWD", "USDTWD", "TWD=X"] : [symbol];
  const quote = candidates.map((candidate) => marketQuotes.get(candidate)).find(Boolean);
  if (!quote) return unavailable("symbol_absent_from_market_data");
  const price = positiveNumber(quote.close ?? quote.price);
  const sourceAt = sourceTimestamp(quote);
  const freshness = assessFreshness(sourceAt, evaluatedAt, 129_600);
  return {
    available: price !== null,
    price,
    changePercent: finiteNumber(quote.changePercent ?? quote.change),
    sourceAt: freshness.sourceAt,
    source: quote.source ?? null,
    sourceSymbol: quote.sourceSymbol ?? null,
    quoteType: "regular_market_quote",
    completedSession: isCompletedSessionQuote(quote),
    session: quote.session ?? quote.sessionStatus ?? null,
    marketState: quote.marketState ?? quote.marketStatus ?? null,
    freshness,
  };
}



function normalizeDirection(marketQuotes, evaluatedAt) {
  const quote = marketQuotes.get("TX_DIRECTION") ?? marketQuotes.get("TX_NIGHT");
  if (!quote) return { ...unavailable("continuous_nearby_absent"), quoteType: "continuous_nearby_direction", contractMonth: null };
  const validClass = quote.quoteType === "continuous_nearby_direction" && quote.explicitContract !== true && !quote.contractMonth;
  if (!validClass) return { ...unavailable("source_is_not_continuous_nearby_direction"), quoteType: "continuous_nearby_direction", contractMonth: null };
  const freshness = assessFreshness(sourceTimestamp(quote), evaluatedAt, 1_800);
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

function validateFrontMonthQuote(quote, evaluatedAt = new Date()) {
  if (!quote) return { valid: false, reason: "explicit_front_month_absent" };
  const sourceText = `${quote.source ?? ""} ${quote.sourceSymbol ?? ""} ${quote.quoteType ?? ""}`.toLowerCase();
  if (sourceText.includes("dailymarketreport") || sourceText.includes("daily market report")) return { valid: false, reason: "daily_report_is_not_live_front_month" };
  if (quote.explicitContract !== true || !/^\d{6}$/.test(String(quote.contractMonth ?? ""))) return { valid: false, reason: "missing_explicit_contract_month" };
  if (quote.quoteType !== "explicit_contract_live" || quote.live !== true) return { valid: false, reason: "quote_is_not_explicit_contract_live" };
  if (!quote.source || quote.quoteType === "continuous_nearby_direction") return { valid: false, reason: "continuous_or_unsourced_quote_rejected" };
  const freshness = assessFreshness(sourceTimestamp(quote), evaluatedAt, 1_800);
  if (!freshness.sourceAt) return { valid: false, reason: "missing_source_timestamp" };
  const price = positiveNumber(quote.last ?? quote.close ?? quote.price);
  const bid = compactArray(quote.bestBid ?? [quote.bid])[0] ?? null;
  const ask = compactArray(quote.bestAsk ?? [quote.ask])[0] ?? null;
  if (price === null && bid === null && ask === null) return { valid: false, reason: "missing_live_price_and_bid_ask" };
  return { valid: true, price, bid, ask, freshness };
}

function normalizeFrontMonth(marketQuotes, evaluatedAt) {
  const quote = marketQuotes.get("TX_FRONT_MONTH");
  const validation = validateFrontMonthQuote(quote, evaluatedAt);
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
  return {
    tradingDate: firstHour.tradingDate ?? null,
    frozenAt: firstHour.frozenAt ?? null,
    through: firstHour.through ?? null,
    symbols,
  };
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
  if (stage !== "1030") return { firstHour: null, intradayWindow: null, samples: [], coverage: null, sourceLimitations: [] };
  const window = snapshot?.intradayWindow;
  if (!isObject(window)) return { firstHour: null, intradayWindow: null, samples: [], coverage: null, sourceLimitations: [] };
  const trendSymbols = {};
  for (const symbol of SPOT_SYMBOLS) {
    const trend = window.trend?.symbols?.[symbol];
    if (trend) trendSymbols[symbol] = trend;
  }
  const firstHour = compactFirstHour(window.firstHour);
  const compactedSamples = compactSamples(window.samples);
  const sampleSymbols = new Set();
  for (const sample of Array.isArray(window.samples) ? window.samples : []) {
    for (const symbol of SPOT_SYMBOLS) if (sample?.quotes?.[symbol]) sampleSymbols.add(symbol);
  }
  const coverage = { firstHour: {}, samples: {} };
  for (const symbol of SPOT_SYMBOLS) {
    coverage.firstHour[symbol] = firstHour?.symbols?.[symbol] ? "available" : "missing";
    coverage.samples[symbol] = sampleSymbols.has(symbol) ? "available" : "missing";
  }
  return {
    firstHour,
    intradayWindow: {
      tradingDate: window.tradingDate ?? null,
      updatedAt: window.updatedAt ?? null,
      cadenceSeconds: finiteNumber(window.cadenceSeconds),
      retentionMinutes: finiteNumber(window.retentionMinutes),
      sampleCount: Array.isArray(window.samples) ? window.samples.length : 0,
      trend: isObject(window.trend) ? { asOf: window.trend.asOf ?? null, sampleCount: finiteNumber(window.trend.sampleCount), symbols: trendSymbols } : null,
    },
    samples: compactedSamples,
    coverage,
    sourceLimitations: [],
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
  if (!sourceAt) return false;
  const date = new Date(sourceAt);
  return Number.isFinite(date.getTime()) && dateInTaipei(date) === targetDate;
}

function midnightGate(data, now) {
  const missingRequired = [];
  const qualityReasons = [];
  const tsm = assessMidnightFreshness(data.overnight.TSM, now);
  const broad = data.overnight.SOX?.available ? assessMidnightFreshness(data.overnight.SOX, now) : assessMidnightFreshness(data.overnight.QQQ_NASDAQ, now);
  if (!data.overnight.TSM?.available) {
    missingRequired.push("overnight.TSM.available");
  } else if (!["fresh", "delayed", "completed-session"].includes(tsm.status) && !(tsm.status === "stale" && !tsm.activeSession)) {
    missingRequired.push("overnight.TSM.current_or_completed_session");
  }
  if (!data.overnight.SOX?.available && !data.overnight.QQQ_NASDAQ?.available) {
    missingRequired.push("overnight.SOX_or_QQQ_NASDAQ.available");
  } else if (!["fresh", "delayed", "completed-session"].includes(broad.status) && !(broad.status === "stale" && !broad.activeSession)) {
    missingRequired.push("overnight.SOX_or_QQQ_NASDAQ.current_or_completed_session");
  }
  for (const [name, assessment] of [["TSM", tsm], ["SOX_or_QQQ_NASDAQ", broad]]) {
    if (assessment.quality === "downgraded") qualityReasons.push("overnight." + name + "." + assessment.classification);
    if (assessment.quality === "blocked") qualityReasons.push("overnight." + name + ".blocked");
  }
  return { missingRequired, qualityReasons, assessments: { TSM: tsm, SOX_or_QQQ_NASDAQ: broad } };
}

function determineStatus(stage, data, fetchErrors, testMode, evaluatedAt = new Date(data.generatedAt ?? Date.now()), startedAt = null) {
  const missingRequired = [];
  const missingOptional = [];
  const qualityReasons = [];
  const collectionStart = startedAt ?? payloadCollectionStartedAt(data, evaluatedAt) ?? evaluatedAt;
  const stageOpen = stageWindowOpen(stage, data.targetDate, collectionStart);
  if (!stageOpen) missingRequired.push("stage." + stage + ".not_before");
  if (!data.marketHealth.available) missingOptional.push("marketHealth");

  if (stage === "1030") {
    const hasFreshCurrentSpot = (symbol) => {
      const quote = data.spot[symbol];
      return quote?.price !== null &&
        quote?.priceKind === "last_trade" &&
        quote?.freshness?.status === "fresh" &&
        sourceDateMatches(quote, data.targetDate);
    };
    for (const symbol of CORE_SPOT) {
      if (!hasFreshCurrentSpot(symbol)) missingRequired.push("spot." + symbol + ".current_last_trade");
    }
    const optionalSpot = data.spot["00631L"];
    if (optionalSpot?.price === null || optionalSpot?.freshness?.status !== "fresh" || !sourceDateMatches(optionalSpot, data.targetDate)) {
      missingOptional.push("spot.00631L.current_last_trade");
    }
    const firstHour = data.intraday.firstHour;
    const firstHourThrough = firstHour?.through ? new Date(firstHour.through) : null;
    const firstHourDate = firstHour?.tradingDate ?? (firstHourThrough && Number.isFinite(firstHourThrough.getTime()) ? dateInTaipei(firstHourThrough) : null);
    if (!firstHour || firstHourDate !== data.targetDate) {
      missingRequired.push("intraday.firstHour.current_target_date");
    } else {
      for (const symbol of ["0050", "TAIEX"]) if (!firstHour.symbols?.[symbol]) missingRequired.push("intraday.firstHour." + symbol);
    }
    const window = data.intraday.intradayWindow;
    if (!window || window.tradingDate !== data.targetDate) {
      missingRequired.push("intraday.intradayWindow.current_target_date");
    } else if (!Number.isFinite(window.sampleCount) || window.sampleCount < 1) {
      missingRequired.push("intraday.intradayWindow.samples");
    } else {
      const currentSamples = (data.intraday.samples ?? []).filter((sample) => {
        const sampleDate = sample?.at ? new Date(sample.at) : null;
        return sampleDate && Number.isFinite(sampleDate.getTime()) && dateInTaipei(sampleDate) === data.targetDate;
      });
      const sampleSymbols = new Set();
      for (const sample of currentSamples) {
        for (const symbol of CORE_SPOT) if (sample?.quotes?.[symbol]) sampleSymbols.add(symbol);
      }
      for (const symbol of ["0050", "TAIEX"]) if (!sampleSymbols.has(symbol)) missingRequired.push("intraday.intradayWindow.samples." + symbol);

      const sourceCoverage = data.intraday.coverage ?? { firstHour: {}, samples: {} };
      const firstHour2330Missing = sourceCoverage.firstHour?.["2330"] === "missing";
      const samples2330Missing = sourceCoverage.samples?.["2330"] === "missing";
      const structurallyUnavailable2330 = firstHour2330Missing && samples2330Missing && hasFreshCurrentSpot("2330");
      if (structurallyUnavailable2330) {
        data.intraday.coverage.firstHour["2330"] = "structurally_unavailable_from_source";
        data.intraday.coverage.samples["2330"] = "structurally_unavailable_from_source";
        data.intraday.sourceLimitations = Array.isArray(data.intraday.sourceLimitations) ? data.intraday.sourceLimitations : [];
        if (!data.intraday.sourceLimitations.includes("intraday.2330_not_sampled_by_source")) {
          data.intraday.sourceLimitations.push("intraday.2330_not_sampled_by_source");
        }
        qualityReasons.push("intraday.2330_not_sampled_by_source");
      } else {
        if (!firstHour.symbols?.["2330"]) missingRequired.push("intraday.firstHour.2330");
        if (!sampleSymbols.has("2330")) missingRequired.push("intraday.intradayWindow.samples.2330");
      }
    }
  } else if (stage === "0850") {
    for (const symbol of CORE_SPOT) {
      const quote = data.spot[symbol];
      const hasObservation = quote?.available && quote?.freshness?.status === "fresh" && sourceDateMatches(quote, data.targetDate);
      if (!hasObservation) missingRequired.push("spot." + symbol + ".current_preopen_observation");
      if (quote?.actualOpen !== null) missingRequired.push("spot." + symbol + ".actualOpen_must_be_null_at_0850");
    }
  } else {
    const midnight = midnightGate(data, evaluatedAt);
    missingRequired.push(...midnight.missingRequired);
    qualityReasons.push(...midnight.qualityReasons);
  }

  if (!data.futures.TX_DIRECTION.available) missingOptional.push("futures.TX_DIRECTION");
  if (!data.futures.TX_FRONT_MONTH.available) missingOptional.push("futures.TX_FRONT_MONTH");
  let status;
  if (fetchErrors.length >= 3) status = "ERROR";
  else if (testMode) status = fetchErrors.length ? "DEGRADED" : "COLLECTING";
  else if (!stageOpen) status = "COLLECTING";
  else if (missingRequired.length === 0) status = "READY";
  else status = "DEGRADED";
  const quality = qualityReasons.length ? "downgraded" : missingRequired.length ? (stageOpen ? "degraded" : "warmup") : "standard";
  return { status, missingRequired, missingOptional, quality, qualityReasons };
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
  const asOf = payload?.generatedAt ?? payload?.asOf;
  const generatedAt = asOf ? new Date(asOf) : null;
  const stageReference = payloadCollectionStartedAt(payload, generatedAt);
  return payload?.status === "READY" &&
    payload?.stage === stage &&
    payload?.targetDate === targetDate &&
    REQUIRED_KEYS.every((key) => key in payload) &&
    generatedAt !== null &&
    Number.isFinite(generatedAt.getTime()) &&
    stageReference !== null &&
    stageWindowOpen(stage, targetDate, stageReference);
}

async function buildPayload(stage, testMode, startedAt = new Date()) {
  const results = await Promise.all(Object.entries(ENDPOINTS).map(async ([name, url]) => [name, await fetchJson(name, url)]));
  const evaluatedAt = new Date();
  const responses = Object.fromEntries(results);
  const fetchErrors = Object.values(responses).map((result) => result.error).filter(Boolean);
  const marketData = responses.marketData.data;
  const snapshot = responses.snapshot.data;
  const quotes = quoteMap(marketData);
  const targetDate = targetDateFor(stage, startedAt);

  const data = {
    schemaVersion: "1.0.0",
    stage,
    status: "COLLECTING",
    generatedAt: evaluatedAt.toISOString(),
    targetDate,
    sourceSite: { baseUrl: SOURCE_SITE, endpoints: ENDPOINTS },
    marketHealth: summarizeHealth(responses.health.data),
    spot: Object.fromEntries(SPOT_SYMBOLS.map((symbol) => [symbol, normalizeSpot(symbol, snapshot, quotes, stage, evaluatedAt)])),
    overnight: Object.fromEntries(OVERNIGHT_SYMBOLS.map((symbol) => [symbol, normalizeOvernight(symbol, quotes, evaluatedAt)])),
    futures: { TX_DIRECTION: normalizeDirection(quotes, evaluatedAt), TX_FRONT_MONTH: normalizeFrontMonth(quotes, evaluatedAt) },
    intraday: normalizeIntraday(snapshot, stage),
    freshnessSummary: null,
    missingRequired: [],
    missingOptional: [],
    errors: fetchErrors.map((message) => ({ source: "public_api", message })),
    collection: {
      testMode,
      latestUpdated: false,
      startedAt: startedAt.toISOString(),
      evaluatedAt: evaluatedAt.toISOString(),
      sourceSchemas: { health: responses.health.data?.status ?? null, marketData: marketData?.schemaVersion ?? null, snapshot: snapshot?.schemaVersion ?? null },
    },
  };
  data.freshnessSummary = freshnessSummary(data, testMode);
  const decision = determineStatus(stage, data, fetchErrors, testMode, evaluatedAt, startedAt);
  data.status = decision.status;
  data.missingRequired = decision.missingRequired;
  data.missingOptional = decision.missingOptional;
  data.freshnessSummary.quality = decision.quality;
  data.freshnessSummary.qualityReasons = decision.qualityReasons;
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
    const readyForLatest = payload.status === "READY" && stageWindowOpen(payload.stage, payload.targetDate, payloadCollectionStartedAt(payload, new Date(payload.generatedAt ?? 0)));
    if (readyForLatest || (payload.status !== "READY" && existing?.status !== "READY")) {
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
  const assert = (condition, message) => {
    if (!condition) failures.push(message);
  };
  const makeFixture = (stage, evaluatedAt, options = {}) => {
    const targetDate = targetDateFor(stage, evaluatedAt);
    const startedAt = options.startedAt ?? evaluatedAt;
    const freshAt = new Date(evaluatedAt.getTime() - 60_000).toISOString();
    const spot = Object.fromEntries(SPOT_SYMBOLS.map((symbol) => [symbol, {
      available: true, price: 100, priceKind: "last_trade",
      actualOpen: stage === "0850" ? null : 100,
      freshness: { status: "fresh", sourceAt: freshAt },
    }]));
    const include2330 = options.intraday2330 !== false;
    const intradaySymbols = include2330 ? CORE_SPOT : ["0050", "TAIEX"];
    const firstHourSymbols = Object.fromEntries(intradaySymbols.map((symbol) => [symbol, { open: 100, high: 101, low: 99, last: 100 }]));
    const samples = [{ at: freshAt, quotes: Object.fromEntries(intradaySymbols.map((symbol) => [symbol, { price: 100 }])) }];
    const coverage = {
      firstHour: Object.fromEntries(SPOT_SYMBOLS.map((symbol) => [symbol, intradaySymbols.includes(symbol) ? "available" : "missing"])),
      samples: Object.fromEntries(SPOT_SYMBOLS.map((symbol) => [symbol, intradaySymbols.includes(symbol) ? "available" : "missing"])),
    };
    const overnightAt = new Date(evaluatedAt.getTime() - (options.overnightAgeSeconds ?? 60) * 1000).toISOString();
    const overnight = Object.fromEntries(["TSM", "SOX"].map((symbol) => [symbol, {
      available: true, price: 100, sourceAt: overnightAt, source: "fixture",
      quoteType: "regular_market_quote", completedSession: options.completedSession === true,
      freshness: { status: "fresh", sourceAt: overnightAt },
    }]));
    overnight.QQQ_NASDAQ = { available: false, price: null, sourceAt: null, freshness: { status: "missing", sourceAt: null } };
    const intraday = options.intradayMissing ? { firstHour: null, intradayWindow: null, samples: [], coverage: null, sourceLimitations: [] } : {
      firstHour: { tradingDate: targetDate, through: targetDate + "T10:00:00+08:00", symbols: firstHourSymbols },
      intradayWindow: { tradingDate: targetDate, sampleCount: 1 }, samples, coverage, sourceLimitations: [],
    };
    return {
      schemaVersion: "1.0.0", stage, status: "COLLECTING", generatedAt: evaluatedAt.toISOString(), targetDate,
      sourceSite: { baseUrl: "fixture", endpoints: {} }, marketHealth: { available: true },
      spot, overnight, futures: { TX_DIRECTION: { available: true }, TX_FRONT_MONTH: { available: true } },
      intraday, freshnessSummary: {}, missingRequired: [], errors: [],
      collection: { testMode: false, latestUpdated: false, startedAt: startedAt.toISOString(), evaluatedAt: evaluatedAt.toISOString() },
    };
  };
  const now = new Date("2026-08-15T02:30:00.000Z");
  assert(assessFreshness("2020-01-01T00:00:00.000Z", now, 600).status === "stale", "old sourceAt became fresh");
  assert(assessFreshness(null, now, 600).status === "missing", "missing sourceAt did not stay missing");
  const sourceBeforeEvaluation = assessFreshness("2026-08-14T19:32:16.000Z", new Date("2026-08-14T19:32:24.000Z"), 1_800);
  assert(sourceBeforeEvaluation.status === "fresh" && sourceBeforeEvaluation.ageSeconds === 8, "sourceAt before evaluatedAt was misclassified");
  const skew = assessFreshness(new Date(now.getTime() + 2_000).toISOString(), now, 1_800);
  assert(skew.status === "fresh" && skew.ageSeconds === 0 && skew.clockSkewClamped === true, "small future clock skew was not clamped to zero");
  assert(assessFreshness(new Date(now.getTime() + 301_000).toISOString(), now, 1_800).status === "invalid", "future source time over five minutes was accepted");
  const nearby = { quoteType: "continuous_nearby_direction", explicitContract: false, contractMonth: null, live: true, close: 20000, source: "continuous nearby", updatedAt: now.toISOString() };
  assert(!validateFrontMonthQuote(nearby, now).valid, "continuous nearby became TX_FRONT_MONTH");
  const daily = { quoteType: "explicit_contract_live", explicitContract: true, contractMonth: "202608", live: true, close: 20000, source: "TAIFEX DailyMarketReport", updatedAt: now.toISOString() };
  assert(!validateFrontMonthQuote(daily, now).valid, "daily report became TX_FRONT_MONTH");
  const bidAskOnly = { quoteType: "explicit_contract_live", explicitContract: true, contractMonth: "202608", live: true, close: null, bestBid: [19999], bestAsk: [20001], source: "live explicit contract", updatedAt: now.toISOString() };
  const bidAskResult = validateFrontMonthQuote(bidAskOnly, now);
  assert(bidAskResult.valid && bidAskResult.price === null && bidAskResult.bid === 19999 && bidAskResult.ask === 20001, "bid/ask-only quote was rejected or midpoint was fabricated");

  const warmStart = new Date("2026-08-15T02:27:00.000Z");
  const warmEvaluation = new Date("2026-08-15T02:32:00.000Z");
  const warm1030 = makeFixture("1030", warmEvaluation, { startedAt: warmStart });
  assert(determineStatus("1030", warm1030, [], false, warmEvaluation, warmStart).status === "COLLECTING", "10:27 start remained eligible after retry crossed gate");
  const readyStart = new Date("2026-08-15T02:32:00.000Z");
  const readyEvaluation = new Date("2026-08-15T02:32:25.000Z");
  const ready1030 = makeFixture("1030", readyEvaluation, { startedAt: readyStart });
  assert(determineStatus("1030", ready1030, [], false, readyEvaluation, readyStart).status === "READY", "10:32 start did not pass the stage gate");

  const warm0850Start = new Date("2026-08-15T00:47:00.000Z");
  const warm0850Evaluation = new Date("2026-08-15T00:52:00.000Z");
  const warm0850 = makeFixture("0850", warm0850Evaluation, { startedAt: warm0850Start });
  assert(determineStatus("0850", warm0850, [], false, warm0850Evaluation, warm0850Start).status === "COLLECTING", "08:47 start remained eligible after retry crossed gate");
  const ready0850 = new Date("2026-08-15T00:52:00.000Z");
  assert(determineStatus("0850", makeFixture("0850", ready0850), [], false, ready0850).status === "READY", "08:52 did not pass the stage gate");

  const warm0000Start = new Date("2026-08-14T15:57:00.000Z");
  const warm0000Evaluation = new Date("2026-08-14T16:03:00.000Z");
  const warm0000 = makeFixture("0000", warm0000Evaluation, { startedAt: warm0000Start });
  assert(determineStatus("0000", warm0000, [], false, warm0000Evaluation, warm0000Start).status === "COLLECTING", "23:57 start remained eligible after retry crossed gate");
  const ready0000 = new Date("2026-08-14T16:03:00.000Z");
  assert(determineStatus("0000", makeFixture("0000", ready0000), [], false, ready0000).status === "READY", "00:03 did not pass the stage gate");

  const preGateLongRunning = makeFixture("1030", warmEvaluation, { startedAt: warmStart });
  preGateLongRunning.status = "READY";
  assert(!isReasonableReady(preGateLongRunning, "1030", preGateLongRunning.targetDate), "pre-gate collection.startedAt was accepted as READY");
  const postGateReady = makeFixture("1030", readyEvaluation, { startedAt: readyStart });
  postGateReady.status = "READY";
  assert(isReasonableReady(postGateReady, "1030", postGateReady.targetDate), "post-gate collection.startedAt was rejected as READY");

  const staleMidnight = makeFixture("0000", ready0000, { overnightAgeSeconds: 31 * 60 });
  const staleDecision = determineStatus("0000", staleMidnight, [], false, ready0000);
  assert(staleDecision.status !== "READY" && staleDecision.missingRequired.some((item) => item.includes("overnight.TSM")), "stale TSM/SOX data became midnight READY");
  const delayedMidnight = makeFixture("0000", ready0000, { overnightAgeSeconds: 20 * 60 });
  const delayedDecision = determineStatus("0000", delayedMidnight, [], false, ready0000);
  assert(delayedDecision.status === "READY" && delayedDecision.quality === "downgraded", "delayed midnight data did not produce downgraded READY quality");

  const structural2330 = makeFixture("1030", readyEvaluation, { intraday2330: false });
  const structuralDecision = determineStatus("1030", structural2330, [], false, readyEvaluation);
  assert(structuralDecision.status === "READY", "structurally unavailable 2330 intraday blocked READY");
  assert(structuralDecision.quality === "downgraded", "structurally unavailable 2330 intraday did not downgrade quality");
  assert(structuralDecision.qualityReasons.includes("intraday.2330_not_sampled_by_source"), "2330 structural source limitation reason missing");
  assert(structural2330.intraday.coverage.firstHour["2330"] === "structurally_unavailable_from_source" &&
    structural2330.intraday.coverage.samples["2330"] === "structurally_unavailable_from_source", "2330 structural coverage schema missing");
  assert(structural2330.intraday.sourceLimitations.includes("intraday.2330_not_sampled_by_source"), "2330 source limitation missing");
  assert(!structural2330.intraday.firstHour.symbols["2330"] && !structural2330.intraday.samples[0].quotes["2330"], "2330 first-hour values were fabricated");

  const complete2330 = makeFixture("1030", readyEvaluation);
  const completeDecision = determineStatus("1030", complete2330, [], false, readyEvaluation);
  assert(completeDecision.status === "READY" && completeDecision.quality === "standard" && complete2330.intraday.sourceLimitations.length === 0, "complete 2330 intraday coverage was downgraded or limited");

  const missingIntraday = makeFixture("1030", readyEvaluation, { intradayMissing: true });
  const missingIntradayDecision = determineStatus("1030", missingIntraday, [], false, readyEvaluation);
  assert(missingIntradayDecision.status !== "READY" && missingIntradayDecision.missingRequired.some((item) => item.startsWith("intraday.")), "1030 missing intraday core was accepted");
  const missing0050 = makeFixture("1030", readyEvaluation);
  delete missing0050.intraday.firstHour.symbols["0050"];
  delete missing0050.intraday.samples[0].quotes["0050"];
  const missing0050Decision = determineStatus("1030", missing0050, [], false, readyEvaluation);
  assert(missing0050Decision.status !== "READY" && missing0050Decision.missingRequired.includes("intraday.firstHour.0050") &&
    missing0050Decision.missingRequired.includes("intraday.intradayWindow.samples.0050"), "missing 0050 first-hour/sample coverage was accepted");

  const templateFiles = [...["0000", "0850", "1030"].flatMap((stage) => ["latest_" + stage + ".json", "status_" + stage + ".json"])];
  for (const fileName of templateFiles) {
    const payload = await readJsonIfPresent(path.join(ROOT, fileName));
    if (!payload) { failures.push(fileName + " missing"); continue; }
    const validation = validatePayload(payload);
    failures.push(...validation.failures.map((failure) => fileName + ": " + failure));
  }
  const sensitiveFixture = { safe: true, api_key: "must-be-detected" };
  assert(findSensitiveKeys(sensitiveFixture).length === 1, "sensitive-key scanner failed");
  if (failures.length) throw new Error("Self-test failed:\n- " + failures.join("\n- "));
  console.log("SELF_TEST_OK templates=" + templateFiles.length + " maxPayloadBytes=" + MAX_PAYLOAD_BYTES);
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
