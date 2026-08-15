#!/usr/bin/env node

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_SITE = 'https://tw-stock-dashboard.netlify.app';
const ENDPOINTS = {
  health: SOURCE_SITE + '/.netlify/functions/market-data-health',
  marketData: SOURCE_SITE + '/.netlify/functions/market-data',
  snapshot: SOURCE_SITE + '/.netlify/functions/market-snapshot',
};
const STAGE = 'close';
const CORE_SYMBOLS = ['0050', '2330', 'TAIEX'];
const ALL_SYMBOLS = [...CORE_SYMBOLS, '00631L'];
const STATUS_VALUES = new Set(['READY', 'COLLECTING', 'DEGRADED', 'ERROR']);
const REQUIRED_KEYS = [
  'schemaVersion', 'stage', 'status', 'generatedAt', 'targetDate', 'sourceSite',
  'marketHealth', 'spot', 'intraday', 'sessionStructure', 'freshnessSummary',
  'missingRequired', 'missingOptional', 'errors', 'collection',
];
const SENSITIVE_KEYS = new Set([
  'position_state', 'fill', 'capital', 'token', 'secret', 'telegram', 'api_key',
]);
const MAX_PAYLOAD_BYTES = 64 * 1024;
const SOURCE_MIN_MINUTES = 13 * 60 + 20;
const CORE_MAX_AGE_SECONDS = 20 * 60;
const CLOCK_SKEW_TOLERANCE_SECONDS = 5;

function parseArgs(argv) {
  const options = { testMode: false, selfTest: false, force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--test-mode') options.testMode = true;
    else if (value === '--self-test') options.selfTest = true;
    else if (value === '--force') options.force = true;
    else throw new Error('Unknown argument: ' + value);
  }
  return options;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function positiveNumber(value) {
  const number = finiteNumber(value);
  return number !== null && number > 0 ? number : null;
}

function taipeiParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.map(({ type, value }) => [type, value]));
}

function dateInTaipei(date) {
  const parts = taipeiParts(date);
  return parts.year + '-' + parts.month + '-' + parts.day;
}

function isWeekdayTaipei(date) {
  return !['Sat', 'Sun'].includes(taipeiParts(date).weekday);
}

function minuteOfDayTaipei(date) {
  const parts = taipeiParts(date);
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function targetDateFor(now) {
  return dateInTaipei(now);
}

function gateAt(targetDate) {
  return new Date(targetDate + 'T13:35:00+08:00');
}

function stageWindowOpen(targetDate, startedAt) {
  const gate = gateAt(targetDate);
  return isWeekdayTaipei(startedAt) &&
    Number.isFinite(gate.getTime()) &&
    startedAt instanceof Date &&
    Number.isFinite(startedAt.getTime()) &&
    startedAt.getTime() >= gate.getTime();
}

function sourceTimestamp(value) {
  return value?.freshness?.sourceAt ?? value?.sourceAt ?? value?.updatedAt ?? null;
}

function assessFreshness(sourceAt, evaluatedAt, maxAgeSeconds = CORE_MAX_AGE_SECONDS) {
  if (!sourceAt) {
    return { status: 'missing', sourceAt: null, ageSeconds: null, maxAgeSeconds, basis: 'sourceAt_or_updatedAt' };
  }
  const sourceMs = Date.parse(sourceAt);
  if (!Number.isFinite(sourceMs)) {
    return { status: 'invalid', sourceAt, ageSeconds: null, maxAgeSeconds, basis: 'sourceAt_or_updatedAt' };
  }
  const rawAgeSeconds = Math.round((evaluatedAt.getTime() - sourceMs) / 1000);
  const clockSkewClamped = rawAgeSeconds < 0 && rawAgeSeconds >= -CLOCK_SKEW_TOLERANCE_SECONDS;
  const ageSeconds = clockSkewClamped ? 0 : rawAgeSeconds < 0 ? null : rawAgeSeconds;
  const status = rawAgeSeconds < -CLOCK_SKEW_TOLERANCE_SECONDS
    ? 'invalid'
    : ageSeconds <= maxAgeSeconds ? 'fresh' : 'stale';
  return {
    status, sourceAt: new Date(sourceMs).toISOString(), ageSeconds, rawAgeSeconds,
    clockSkewClamped, maxAgeSeconds, basis: 'sourceAt_or_updatedAt',
  };
}

function sourceDateMatches(value, targetDate) {
  const timestamp = value?.sourceAt;
  const date = timestamp ? new Date(timestamp) : null;
  return date !== null && Number.isFinite(date.getTime()) && dateInTaipei(date) === targetDate;
}

function sourceTimeQualifies(value, targetDate) {
  const timestamp = value?.sourceAt;
  const date = timestamp ? new Date(timestamp) : null;
  return sourceDateMatches(value, targetDate) &&
    date !== null && minuteOfDayTaipei(date) >= SOURCE_MIN_MINUTES;
}

function quoteMap(marketData) {
  const map = new Map();
  for (const quote of Array.isArray(marketData?.quotes) ? marketData.quotes : []) {
    if (typeof quote?.symbol === 'string') map.set(quote.symbol, quote);
  }
  return map;
}

function quoteCandidate(symbol, snapshot, marketQuotes) {
  const snapshotQuote = snapshot?.quotes?.[symbol];
  const marketQuote = marketQuotes.get(symbol);
  const candidates = [snapshotQuote, marketQuote].filter(isObject);
  return candidates.find((quote) => (
    quote.priceKind === 'last_trade' &&
    quote.isReferencePrice !== true &&
    positiveNumber(quote.price ?? quote.close) !== null &&
    positiveNumber(quote.open) !== null &&
    positiveNumber(quote.high) !== null &&
    positiveNumber(quote.low) !== null &&
    positiveNumber(quote.previousClose) !== null
  )) ?? candidates[0] ?? null;
}

function normalizeQuote(symbol, snapshot, marketQuotes, evaluatedAt) {
  const selected = quoteCandidate(symbol, snapshot, marketQuotes);
  if (!selected) {
    return {
      available: false, close: null, open: null, high: null, low: null, previousClose: null,
      priceKind: null, isReferencePrice: null, sourceAt: null, updatedAt: null, source: null,
      freshness: assessFreshness(null, evaluatedAt), reason: 'symbol_absent_from_sources',
      timestampsValid: false, datesMatch: false,
    };
  }
  const close = positiveNumber(selected.close ?? selected.price);
  const sourceAt = sourceTimestamp(selected);
  const updatedAt = selected.updatedAt ?? null;
  const freshness = assessFreshness(sourceAt, evaluatedAt);
  const dateFields = [sourceAt, updatedAt].filter(Boolean);
  const timestampsValid = dateFields.every((value) => Number.isFinite(new Date(value).getTime()));
  const datesMatch = dateFields.every((value) => dateInTaipei(new Date(value)) === dateInTaipei(evaluatedAt));
  return {
    available: close !== null, close, open: positiveNumber(selected.open),
    high: positiveNumber(selected.high), low: positiveNumber(selected.low),
    previousClose: positiveNumber(selected.previousClose),
    changePercent: finiteNumber(selected.changePercent ?? selected.change),
    priceKind: selected.priceKind ?? null, isReferencePrice: selected.isReferencePrice === true,
    sourceAt: freshness.sourceAt, updatedAt, source: selected.source ?? selected.sourceChannel ?? null,
    timestampsValid, datesMatch, freshness,
  };
}

function deriveCloseMetrics(quote) {
  const closeVsOpenPercent = quote.close !== null && quote.open !== null && quote.open !== 0
    ? Number((((quote.close - quote.open) / quote.open) * 100).toFixed(4)) : null;
  let closeLocationPercent = null;
  let closePosition = null;
  if (quote.close !== null && quote.high !== null && quote.low !== null &&
      quote.high >= quote.low && quote.close >= quote.low && quote.close <= quote.high) {
    closeLocationPercent = quote.high === quote.low
      ? 50 : Number((((quote.close - quote.low) / (quote.high - quote.low)) * 100).toFixed(4));
    closePosition = closeLocationPercent <= 33.3333
      ? 'near_low' : closeLocationPercent >= 66.6667 ? 'near_high' : 'middle';
  }
  return { closeVsOpenPercent, closeLocationPercent, closePosition };
}

function normalizeIntraday(snapshot, targetDate) {
  const window = snapshot?.intradayWindow;
  const firstHour = isObject(window?.firstHour) ? {
    tradingDate: window.firstHour.tradingDate ?? null,
    frozenAt: window.firstHour.frozenAt ?? null,
    through: window.firstHour.through ?? null,
    symbols: Object.fromEntries(ALL_SYMBOLS.flatMap((symbol) => {
      const value = window.firstHour.symbols?.[symbol];
      return value ? [[symbol, {
        open: positiveNumber(value.open), high: positiveNumber(value.high),
        low: positiveNumber(value.low), last: positiveNumber(value.last),
        rangePercent: finiteNumber(value.rangePercent), precision: value.precision ?? null,
      }]] : [];
    })),
  } : null;
  const rawSamples = Array.isArray(window?.samples) ? window.samples : [];
  const samples = rawSamples.slice(-6).map((sample) => ({
    at: sample?.at ?? null,
    quotes: Object.fromEntries(ALL_SYMBOLS.flatMap((symbol) => {
      const quote = sample?.quotes?.[symbol];
      return quote ? [[symbol, {
        price: positiveNumber(quote.price), high: positiveNumber(quote.high),
        low: positiveNumber(quote.low), changePercent: finiteNumber(quote.changePercent),
        sourceAt: quote.sourceAt ?? null,
      }]] : [];
    })),
  }));
  const coverage = { firstHour: {}, samples: {} };
  for (const symbol of ALL_SYMBOLS) {
    coverage.firstHour[symbol] = firstHour?.symbols?.[symbol] ? 'available' : 'missing';
    coverage.samples[symbol] = rawSamples.some((sample) => sample?.quotes?.[symbol]) ? 'available' : 'missing';
  }
  const sourceLimitations = [];
  if (!window || (coverage.firstHour['2330'] === 'missing' && coverage.samples['2330'] === 'missing')) {
    coverage.firstHour['2330'] = 'structurally_unavailable_from_source';
    coverage.samples['2330'] = 'structurally_unavailable_from_source';
    sourceLimitations.push('intraday.2330_not_sampled_by_source');
  }
  return {
    firstHour, intradayWindow: window ? {
      tradingDate: window.tradingDate ?? null, updatedAt: window.updatedAt ?? null,
      cadenceSeconds: finiteNumber(window.cadenceSeconds),
      retentionMinutes: finiteNumber(window.retentionMinutes),
      sampleCount: rawSamples.length, currentTargetDate: window.tradingDate === targetDate,
    } : null,
    samples, coverage, sourceLimitations,
  };
}

function summarizeHealth(health) {
  if (!isObject(health)) return { available: false, status: 'unavailable', checkedAt: null, components: {} };
  const components = {};
  for (const name of ['marketData', 'marketSnapshot', 'intradaySampler']) {
    const component = health.components?.[name];
    if (!component) continue;
    components[name] = {
      ok: component.ok === true, httpStatus: finiteNumber(component.httpStatus),
      mode: component.mode ?? null, sourceAt: component.lastSampleAt ?? null,
      sampleCount: finiteNumber(component.sampleCount),
      firstHourReady: typeof component.firstHourReady === 'boolean' ? component.firstHourReady : null,
    };
  }
  return {
    available: true, ok: health.ok === true, status: health.status ?? 'unknown',
    checkedAt: health.checkedAt ?? null, session: health.session ?? null, components,
  };
}

function freshnessSummary(spot, testMode) {
  const records = CORE_SYMBOLS.map((symbol) => spot[symbol].freshness);
  const counts = { fresh: 0, stale: 0, missing: 0, invalid: 0 };
  const timestamps = [];
  for (const record of records) {
    counts[record.status] = (counts[record.status] ?? 0) + 1;
    if (record.sourceAt) timestamps.push(record.sourceAt);
  }
  timestamps.sort();
  return {
    basis: 'sourceAt_or_updatedAt_only', fetchedAtIsFreshnessEvidence: false,
    maxAgeSeconds: CORE_MAX_AGE_SECONDS, testMode, counts,
    oldestSourceAt: timestamps[0] ?? null, newestSourceAt: timestamps.at(-1) ?? null,
  };
}

function coreQuoteReady(quote, targetDate) {
  return quote.available && quote.close !== null && quote.open !== null &&
    quote.high !== null && quote.low !== null && quote.previousClose !== null &&
    quote.priceKind === 'last_trade' && quote.isReferencePrice !== true &&
    quote.freshness.status === 'fresh' && sourceDateMatches(quote, targetDate) &&
    sourceTimeQualifies(quote, targetDate) && quote.timestampsValid && quote.datesMatch;
}

function buildSessionStructure(spot) {
  const comparable = CORE_SYMBOLS.map((symbol) => spot[symbol]).filter((quote) => (
    quote.close !== null && quote.previousClose !== null && quote.closePosition !== null
  ));
  const negativeCount = comparable.filter((quote) => quote.close < quote.previousClose).length;
  const positiveCount = comparable.filter((quote) => quote.close > quote.previousClose).length;
  const nearLowCount = comparable.filter((quote) => quote.closePosition === 'near_low').length;
  const nearHighCount = comparable.filter((quote) => quote.closePosition === 'near_high').length;
  const allCore = comparable.length === CORE_SYMBOLS.length;
  return {
    symbols: CORE_SYMBOLS, comparableCount: comparable.length,
    negativeCount, positiveCount, nearLowCount, nearHighCount,
    synchronizedWeakClose: allCore && negativeCount === CORE_SYMBOLS.length && nearLowCount >= 2,
    synchronizedStrongClose: allCore && positiveCount === CORE_SYMBOLS.length && nearHighCount >= 2,
  };
}

function determineStatus(data, fetchErrors, testMode, evaluatedAt, startedAt) {
  const missingRequired = [];
  const missingOptional = [];
  const qualityReasons = [];
  const weekday = isWeekdayTaipei(startedAt);
  const gateOpen = weekday && stageWindowOpen(data.targetDate, startedAt);
  if (!weekday) missingRequired.push('stage.close.weekday_only');
  else if (!gateOpen) missingRequired.push('stage.close.not_before_13:35');
  for (const symbol of CORE_SYMBOLS) {
    if (!coreQuoteReady(data.spot[symbol], data.targetDate)) {
      missingRequired.push('spot.' + symbol + '.formal_close_core');
    }
  }
  if (!coreQuoteReady(data.spot['00631L'], data.targetDate)) {
    missingOptional.push('spot.00631L.formal_close_optional');
  }
  if (data.intraday.sourceLimitations.includes('intraday.2330_not_sampled_by_source')) {
    qualityReasons.push('intraday.2330_not_sampled_by_source');
  }
  if (!data.intraday.firstHour || !data.intraday.intradayWindow) {
    qualityReasons.push('intraday.auxiliary_window_unavailable');
  }
  let status;
  if (fetchErrors.length === 3) status = 'ERROR';
  else if (testMode || !gateOpen) status = 'COLLECTING';
  else if (missingRequired.length > 0) status = 'DEGRADED';
  else status = 'READY';
  const quality = qualityReasons.length ? 'downgraded'
    : missingRequired.length ? (gateOpen ? 'degraded' : 'warmup') : 'standard';
  return { status, missingRequired, missingOptional, quality, qualityReasons };
}

function findSensitiveKeys(value, pathParts = [], found = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findSensitiveKeys(item, [...pathParts, String(index)], found));
  } else if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (SENSITIVE_KEYS.has(key.toLowerCase())) found.push([...pathParts, key].join('.'));
      findSensitiveKeys(item, [...pathParts, key], found);
    }
  }
  return found;
}

function validatePayload(payload) {
  const failures = [];
  for (const key of REQUIRED_KEYS) if (!(key in payload)) failures.push('missing top-level key: ' + key);
  if (payload.stage !== STAGE) failures.push('invalid stage: ' + payload.stage);
  if (!STATUS_VALUES.has(payload.status)) failures.push('invalid status: ' + payload.status);
  const sensitive = findSensitiveKeys(payload);
  if (sensitive.length) failures.push('sensitive keys found: ' + sensitive.join(', '));
  const bytes = Buffer.byteLength(JSON.stringify(payload, null, 2) + '\n', 'utf8');
  if (bytes > MAX_PAYLOAD_BYTES) failures.push('payload ' + bytes + ' exceeds ' + MAX_PAYLOAD_BYTES + ' bytes');
  return { failures, bytes };
}

async function fetchJson(name, url, options = {}) {
  const delays = options.delays ?? [0, 15_000, 30_000];
  const timeoutMs = options.timeoutMs ?? 25_000;
  let lastError;
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt] > 0) await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': 'market-decision-feed/close-1.0' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const text = await response.text();
      const data = JSON.parse(text);
      console.log('API ' + name + ' ok status=' + response.status + ' bytes=' +
        Buffer.byteLength(text, 'utf8') + ' attempt=' + (attempt + 1));
      return { data, error: null };
    } catch (error) {
      lastError = error;
      console.warn('API ' + name + ' failed attempt=' + (attempt + 1) + '/' +
        delays.length + ': ' + error.message);
    }
  }
  return { data: null, error: name + ': ' + (lastError?.message ?? 'unknown error') };
}

async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function buildPayload(testMode, startedAt = new Date(), evaluatedAtOverride = null, fetcher = fetchJson) {
  const results = await Promise.all(Object.entries(ENDPOINTS).map(async ([name, url]) => [
    name, await fetcher(name, url),
  ]));
  const evaluatedAt = evaluatedAtOverride ?? new Date();
  const responses = Object.fromEntries(results);
  const fetchErrors = Object.values(responses).map((result) => result.error).filter(Boolean);
  const marketData = responses.marketData.data;
  const snapshot = responses.snapshot.data;
  const targetDate = targetDateFor(startedAt);
  const marketQuotes = quoteMap(marketData);
  const spot = Object.fromEntries(ALL_SYMBOLS.map((symbol) => {
    const quote = normalizeQuote(symbol, snapshot, marketQuotes, evaluatedAt);
    return [symbol, { ...quote, ...deriveCloseMetrics(quote) }];
  }));
  const data = {
    schemaVersion: '1.0.0', stage: STAGE, status: 'COLLECTING',
    generatedAt: evaluatedAt.toISOString(), targetDate,
    sourceSite: { baseUrl: SOURCE_SITE, endpoints: ENDPOINTS },
    marketHealth: summarizeHealth(responses.health.data), spot,
    intraday: normalizeIntraday(snapshot, targetDate),
    sessionStructure: buildSessionStructure(spot),
    freshnessSummary: freshnessSummary(spot, testMode),
    missingRequired: [], missingOptional: [],
    errors: fetchErrors.map((message) => ({ source: 'public_api', message })),
    collection: {
      testMode, latestUpdated: false, startedAt: startedAt.toISOString(),
      evaluatedAt: evaluatedAt.toISOString(),
      sourceSchemas: {
        health: responses.health.data?.status ?? null,
        marketData: marketData?.schemaVersion ?? null,
        snapshot: snapshot?.schemaVersion ?? null,
      },
    },
  };
  const decision = determineStatus(data, fetchErrors, testMode, evaluatedAt, startedAt);
  data.status = decision.status;
  data.missingRequired = decision.missingRequired;
  data.missingOptional = decision.missingOptional;
  data.freshnessSummary.quality = decision.quality;
  data.freshnessSummary.qualityReasons = decision.qualityReasons;
  return data;
}

async function writeCollection(payload, testMode, root = ROOT) {
  const statusPath = path.join(root, 'status_close.json');
  const latestPath = path.join(root, 'latest_close.json');
  const validation = validatePayload(payload);
  if (validation.failures.length) throw new Error('Output validation failed: ' + validation.failures.join('; '));
  await writeFile(statusPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  let latestUpdated = false;
  if (!testMode && payload.status === 'READY') {
    const latest = structuredClone(payload);
    latest.collection.latestUpdated = true;
    const latestValidation = validatePayload(latest);
    if (latestValidation.failures.length) throw new Error('Latest validation failed: ' + latestValidation.failures.join('; '));
    await writeFile(latestPath, JSON.stringify(latest, null, 2) + '\n', 'utf8');
    latestUpdated = true;
  }
  console.log('RESULT stage=close status=' + payload.status + ' targetDate=' + payload.targetDate +
    ' testMode=' + testMode + ' latestUpdated=' + latestUpdated + ' statusBytes=' + validation.bytes);
  return { latestUpdated, validation };
}

function isReasonableReady(payload, targetDate) {
  const startedAt = payload?.collection?.startedAt ? new Date(payload.collection.startedAt) : null;
  return payload?.status === 'READY' && payload?.stage === STAGE &&
    payload?.targetDate === targetDate && startedAt !== null &&
    Number.isFinite(startedAt.getTime()) && stageWindowOpen(targetDate, startedAt);
}

function makeFixture(evaluatedAt, options = {}) {
  const targetDate = dateInTaipei(evaluatedAt);
  const startedAt = options.startedAt ?? evaluatedAt;
  const sourceAt = options.sourceAt ?? new Date(evaluatedAt.getTime() - 7 * 60 * 1000).toISOString();
  const spot = Object.fromEntries(ALL_SYMBOLS.map((symbol, index) => {
    const close = options.closeValues?.[symbol] ?? 100 + index;
    const open = options.openValues?.[symbol] ?? 102 + index;
    const high = options.highValues?.[symbol] ?? 105 + index;
    const low = options.lowValues?.[symbol] ?? 95 + index;
    const previousClose = options.previousCloseValues?.[symbol] ?? 101 + index;
    const quote = {
      available: true, close, open, high, low, previousClose,
      priceKind: 'last_trade', isReferencePrice: false,
      sourceAt, updatedAt: sourceAt, source: 'fixture',
      timestampsValid: true, datesMatch: true,
      freshness: assessFreshness(sourceAt, evaluatedAt),
    };
    return [symbol, { ...quote, ...deriveCloseMetrics(quote) }];
  }));
  if (options.staleSymbol) {
    spot[options.staleSymbol].sourceAt = new Date(evaluatedAt.getTime() - 30 * 60 * 1000).toISOString();
    spot[options.staleSymbol].freshness = assessFreshness(spot[options.staleSymbol].sourceAt, evaluatedAt);
  }
  if (options.futureSourceAt) {
    spot['0050'].sourceAt = options.futureSourceAt;
    spot['0050'].freshness = assessFreshness(options.futureSourceAt, evaluatedAt);
  }
  const intraday = options.intradayMissing ? {
    firstHour: null, intradayWindow: null, samples: [],
    coverage: { firstHour: { '2330': 'structurally_unavailable_from_source' }, samples: { '2330': 'structurally_unavailable_from_source' } },
    sourceLimitations: ['intraday.2330_not_sampled_by_source'],
  } : {
    firstHour: { tradingDate: targetDate, symbols: { '0050': { open: 100 }, TAIEX: { open: 100 } } },
    intradayWindow: { tradingDate: targetDate, sampleCount: 1 },
    samples: [{ at: sourceAt, quotes: { '0050': { price: 100 }, TAIEX: { price: 100 } } }],
    coverage: { firstHour: { '2330': options.intraday2330 ? 'available' : 'structurally_unavailable_from_source' }, samples: { '2330': options.intraday2330 ? 'available' : 'structurally_unavailable_from_source' } },
    sourceLimitations: options.intraday2330 ? [] : ['intraday.2330_not_sampled_by_source'],
  };
  const data = {
    schemaVersion: '1.0.0', stage: STAGE, status: 'COLLECTING',
    generatedAt: evaluatedAt.toISOString(), targetDate,
    sourceSite: { baseUrl: SOURCE_SITE, endpoints: ENDPOINTS },
    marketHealth: { available: true }, spot, intraday,
    sessionStructure: buildSessionStructure(spot),
    freshnessSummary: freshnessSummary(spot, false),
    missingRequired: [], missingOptional: [], errors: [],
    collection: { testMode: false, latestUpdated: false, startedAt: startedAt.toISOString(), evaluatedAt: evaluatedAt.toISOString() },
  };
  const decision = determineStatus(data, [], false, evaluatedAt, startedAt);
  data.status = decision.status;
  data.missingRequired = decision.missingRequired;
  data.missingOptional = decision.missingOptional;
  data.freshnessSummary.quality = decision.quality;
  data.freshnessSummary.qualityReasons = decision.qualityReasons;
  return data;
}

async function runSelfTest() {
  const failures = [];
  const assert = (condition, message) => { if (!condition) failures.push(message); };
  const evaluation = new Date('2026-08-14T05:37:00.000Z');
  const targetDate = '2026-08-14';
  const preGate = new Date('2026-08-14T05:32:00.000Z');
  const postGate = new Date('2026-08-14T05:37:00.000Z');
  assert(!stageWindowOpen(targetDate, preGate), '13:32 was formal READY eligible');
  assert(stageWindowOpen(targetDate, postGate), '13:37 was not formal READY eligible');
  assert(determineStatus(makeFixture(evaluation, { startedAt: preGate }), [], false, evaluation, preGate).status === 'COLLECTING', '13:32 did not remain non-READY');
  assert(determineStatus(makeFixture(evaluation, { startedAt: postGate }), [], false, evaluation, postGate).status === 'READY', '13:37 did not become READY');
  const stale = makeFixture(evaluation, { startedAt: postGate, staleSymbol: '0050' });
  const staleDecision = determineStatus(stale, [], false, evaluation, postGate);
  assert(staleDecision.status === 'DEGRADED' && staleDecision.missingRequired.includes('spot.0050.formal_close_core'), 'stale core close passed READY');
  const qualifies = makeFixture(evaluation, { startedAt: postGate, sourceAt: '2026-08-14T05:30:00.000Z' });
  assert(sourceTimeQualifies(qualifies.spot['0050'], targetDate), '13:30 source did not qualify close source window');
  const tooEarly = makeFixture(evaluation, { startedAt: postGate, sourceAt: '2026-08-14T04:30:00.000Z' });
  assert(!sourceTimeQualifies(tooEarly.spot['0050'], targetDate), '12:30 source qualified close source window');
  const low = makeFixture(evaluation, { startedAt: postGate, closeValues: { '0050': 95 }, lowValues: { '0050': 95 } });
  const high = makeFixture(evaluation, { startedAt: postGate, closeValues: { '0050': 105 }, highValues: { '0050': 105 } });
  assert(low.spot['0050'].closeLocationPercent === 0 && low.spot['0050'].closePosition === 'near_low', 'close-at-low was not 0');
  assert(high.spot['0050'].closeLocationPercent === 100 && high.spot['0050'].closePosition === 'near_high', 'close-at-high was not 100');
  const futureAt = new Date(evaluation.getTime() + 6 * 1000).toISOString();
  const future = makeFixture(evaluation, { startedAt: postGate, futureSourceAt: futureAt });
  assert(future.spot['0050'].freshness.status === 'invalid', 'future source timestamp over tolerance was accepted');
  const noIntraday = makeFixture(evaluation, { startedAt: postGate });
  const noIntradayDecision = determineStatus(noIntraday, [], false, evaluation, postGate);
  assert(noIntradayDecision.status === 'READY', 'missing 2330 intraday blocked close READY');
  assert(noIntradayDecision.quality === 'downgraded' && noIntradayDecision.qualityReasons.includes('intraday.2330_not_sampled_by_source'), 'missing 2330 intraday did not downgrade quality');
  const testPayload = makeFixture(evaluation, { startedAt: postGate });
  const testDecision = determineStatus(testPayload, [], true, evaluation, postGate);
  testPayload.status = testDecision.status;
  testPayload.missingRequired = testDecision.missingRequired;
  testPayload.missingOptional = testDecision.missingOptional;
  testPayload.freshnessSummary.quality = testDecision.quality;
  testPayload.freshnessSummary.qualityReasons = testDecision.qualityReasons;
  testPayload.collection.testMode = true;
  assert(testPayload.status !== 'READY', 'test mode produced READY');
  assert(findSensitiveKeys({ safe: true, api_key: 'detect-me' }).length === 1, 'sensitive-key scan failed');
  assert(validatePayload(testPayload).failures.length === 0, 'fixture payload validation failed');
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'market-close-self-test-'));
  try {
    const sentinel = JSON.stringify({ sentinel: true });
    await writeFile(path.join(tempRoot, 'latest_close.json'), sentinel, 'utf8');
    await writeCollection(testPayload, true, tempRoot);
    const latestAfter = await readFile(path.join(tempRoot, 'latest_close.json'), 'utf8');
    assert(latestAfter === sentinel, 'test mode changed latest_close.json');
    const statusAfter = await readJsonIfPresent(path.join(tempRoot, 'status_close.json'));
    assert(statusAfter?.collection?.testMode === true, 'test evidence fixture was not written as expected');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
  if (failures.length) throw new Error('Self-test failed:\n- ' + failures.join('\n- '));
  console.log('SELF_TEST_OK close gate=13:35 sourceMinimum=13:20 maxAgeSeconds=' +
    CORE_MAX_AGE_SECONDS + ' maxPayloadBytes=' + MAX_PAYLOAD_BYTES);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) {
    await runSelfTest();
    return;
  }
  const startedAt = new Date();
  const targetDate = targetDateFor(startedAt);
  const existingLatest = await readJsonIfPresent(path.join(ROOT, 'latest_close.json'));
  if (!options.testMode && !options.force && isReasonableReady(existingLatest, targetDate)) {
    console.log('SKIP stage=close targetDate=' + targetDate + ' reason=reasonable_ready_exists');
    return;
  }
  const payload = await buildPayload(options.testMode, startedAt);
  await writeCollection(payload, options.testMode);
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});

