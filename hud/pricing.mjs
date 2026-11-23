/**
 * Standard API-equivalent cost estimator for Antigravity sessions.
 *
 * Uses a two-tier rate resolver (inspired by ahmetdotsh/agy-usage, MIT):
 *   1. Live public pricing from BerriAI/litellm's `model_prices_and_context_window.json`
 *      cached locally for 24h (fetched asynchronously in the background, never blocks).
 *   2. Built-in fallback table for preview/codename models not yet in LiteLLM.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const LITELLM_RATES_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const RATES_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_DIR = join(homedir(), 'Library', 'Caches', 'dev.agy-context.hud');
const CACHE_PATH = join(CACHE_DIR, 'litellm-rates.json');

// Standard (non-promotional) API-equivalent rates in USD per 1M tokens.
const BUILTIN_RATES = {
  'gemini-4-carbon': { inPerM: 4, outPerM: 20, crPerM: 0.2 },
  'gemini-pro-orchestrator': { inPerM: 4, outPerM: 20, crPerM: 0.2 },
  'gemini-pro-orchestrator-argon': { inPerM: 4, outPerM: 20, crPerM: 0.2 },
  'gemini-4-argon': { inPerM: 4, outPerM: 20, crPerM: 0.2 },
  'gemini-4-hydrogen': { inPerM: 1.5, outPerM: 7.5, crPerM: 0.075 },
  'gemini-4-neon': { inPerM: 1.5, outPerM: 7.5, crPerM: 0.075 },
  'gemini-3.8-flash': { inPerM: 1.5, outPerM: 7.5, crPerM: 0.15 },
  'gemini-flash-worker-agy': { inPerM: 1.5, outPerM: 7.5, crPerM: 0.15 },
  'gemini-3.7-flash': { inPerM: 0.75, outPerM: 3.75, crPerM: 0.075 },
  'gemini-3.6-flash': { inPerM: 0.75, outPerM: 3.75, crPerM: 0.075 },
  'gemini-3.5-flash': { inPerM: 1.5, outPerM: 9, crPerM: 0.15 },
  'gemini-3.5-flash-lite': { inPerM: 0.3, outPerM: 2.5, crPerM: 0.03 },
  'gemini-3.1-pro': { inPerM: 2, outPerM: 12, crPerM: 0.2 },
  'gemini-3.1-flash-lite': { inPerM: 0.25, outPerM: 1.5, crPerM: 0.025 },
  'gemini-3-flash-preview': { inPerM: 0.5, outPerM: 3, crPerM: 0.05 },
  'gemini-2.5-pro': { inPerM: 1.25, outPerM: 10, crPerM: 0.125 },
  'gemini-2.5-flash': { inPerM: 0.3, outPerM: 2.5, crPerM: 0.03 },
  'gemini-2.5-flash-lite': { inPerM: 0.1, outPerM: 0.4, crPerM: 0.01 },
  'claude-opus-5-5': { inPerM: 4, outPerM: 20, crPerM: 0.2 },
  'claude-opus-5': { inPerM: 5, outPerM: 25, crPerM: 0.5 },
  'claude-opus-4-6': { inPerM: 5, outPerM: 25, crPerM: 0.5 },
  'claude-opus-4-5': { inPerM: 5, outPerM: 25, crPerM: 0.5 },
  'claude-opus-4': { inPerM: 15, outPerM: 75, crPerM: 1.5 },
  'claude-sonnet-5-5': { inPerM: 3, outPerM: 15, crPerM: 0.3 },
  'claude-sonnet-4-6': { inPerM: 3, outPerM: 15, crPerM: 0.3 },
  'claude-sonnet-4-5': { inPerM: 3, outPerM: 15, crPerM: 0.3 },
  'claude-sonnet-4': { inPerM: 3, outPerM: 15, crPerM: 0.3 },
  'claude-haiku-4-5': { inPerM: 1, outPerM: 5, crPerM: 0.1 },
  'gpt-oss-120b': { inPerM: 0.15, outPerM: 0.6, crPerM: 0.015 },
};

let litellmDoc = null;
let litellmFetchedAt = 0;
let fetchInFlight = false;

function loadDiskCacheOnce() {
  if (litellmDoc !== null) return;
  try {
    if (existsSync(CACHE_PATH)) {
      const parsed = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
      if (parsed && typeof parsed.document === 'object' && parsed.document) {
        litellmDoc = parsed.document;
        litellmFetchedAt = Number(parsed.fetchedAtMs) || 0;
        return;
      }
    }
  } catch {}
  litellmDoc = {};
}

function maybeRefreshLitellmInBackground() {
  loadDiskCacheOnce();
  const now = Date.now();
  if (fetchInFlight || now - litellmFetchedAt < RATES_TTL_MS) return;
  fetchInFlight = true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  fetch(LITELLM_RATES_URL, { signal: controller.signal })
    .then((res) => (res.ok ? res.json() : null))
    .then((doc) => {
      if (doc && typeof doc === 'object') {
        litellmDoc = doc;
        litellmFetchedAt = Date.now();
        try {
          mkdirSync(CACHE_DIR, { recursive: true });
          writeFileSync(
            CACHE_PATH,
            JSON.stringify({ fetchedAtMs: litellmFetchedAt, source: LITELLM_RATES_URL, document: doc })
          );
        } catch {}
      }
    })
    .catch(() => {})
    .finally(() => {
      clearTimeout(timer);
      fetchInFlight = false;
    });
}

function normalizeModelBase(modelId) {
  if (!modelId || typeof modelId !== 'string') return '';
  return modelId
    .trim()
    .toLowerCase()
    .replace(/-(?:extra-low|low|medium|high|xhigh|tiered|thinking)$/, '');
}

function lookupLitellmRate(baseId) {
  if (!litellmDoc || !baseId) return null;
  const candidates = [
    baseId,
    `gemini/${baseId}`,
    `vertex_ai/${baseId}`,
    `anthropic/${baseId}`,
    baseId.replace(/-(\d+)-(\d+)$/, '-$1.$2'),
  ];
  for (const key of candidates) {
    const entry = litellmDoc[key];
    if (!entry || typeof entry !== 'object') continue;
    const inTok = Number(entry.input_cost_per_token);
    const outTok = Number(entry.output_cost_per_token);
    if (Number.isFinite(inTok) && inTok > 0 && Number.isFinite(outTok) && outTok > 0) {
      const crTok = Number(entry.cache_read_input_token_cost);
      return {
        inPerM: inTok * 1e6,
        outPerM: outTok * 1e6,
        crPerM: Number.isFinite(crTok) && crTok >= 0 ? crTok * 1e6 : inTok * 1e6 * 0.1,
        source: 'litellm',
      };
    }
  }
  return null;
}

function resolveRate(modelId) {
  maybeRefreshLitellmInBackground();
  const base = normalizeModelBase(modelId);
  if (!base) return null;

  const live = lookupLitellmRate(base);
  if (live) return live;

  if (BUILTIN_RATES[base]) {
    return { ...BUILTIN_RATES[base], source: 'builtin' };
  }
  // Prefix fallback (e.g. gemini-4-neon-foo -> gemini-4-neon)
  for (const [k, v] of Object.entries(BUILTIN_RATES)) {
    if (base.startsWith(k)) {
      return { ...v, source: 'builtin' };
    }
  }
  return null;
}

export function estimateSessionCost(modelId, cacheStats) {
  const rate = resolveRate(modelId);
  const cumIn = Number(cacheStats?.cumulativeInputTokens) || 0;
  const cumCached = Number(cacheStats?.cumulativeCachedTokens) || 0;
  const cumOut = Number(cacheStats?.cumulativeOutputTokens) || 0;

  if (!rate || (cumIn <= 0 && cumOut <= 0)) {
    return {
      available: false,
      apiUsd: 0,
      cacheSavedUsd: 0,
      withoutCacheUsd: 0,
      rateSource: '',
    };
  }

  const freshIn = Math.max(0, cumIn - cumCached);
  const apiUsd = (freshIn * rate.inPerM + cumCached * rate.crPerM + cumOut * rate.outPerM) / 1e6;
  const withoutCacheUsd = (cumIn * rate.inPerM + cumOut * rate.outPerM) / 1e6;
  const cacheSavedUsd = Math.max(0, withoutCacheUsd - apiUsd);

  return {
    available: true,
    apiUsd: Number(apiUsd.toFixed(4)),
    cacheSavedUsd: Number(cacheSavedUsd.toFixed(4)),
    withoutCacheUsd: Number(withoutCacheUsd.toFixed(4)),
    rateSource: rate.source,
  };
}
