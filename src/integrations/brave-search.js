// src/integrations/brave-search.js
// Brave Search API client for Razor.

import axios from 'axios';
import makeLogger from '../utils/logger.js';
import { integrationConfig } from './config.js';

const log = makeLogger('BraveSearch');

const BASE_URL = 'https://api.search.brave.com/res/v1/web/search';

// ---------------------------------------------------------------------------
// 1 request / second rate limiter (simple serial queue)
// ---------------------------------------------------------------------------
let _lastRequest = 0;
const MIN_INTERVAL = 1_000; // 1 s

async function throttle() {
  const now = Date.now();
  const wait = MIN_INTERVAL - (now - _lastRequest);
  if (wait > 0) {
    log.info(`Rate limit: waiting ${wait}ms`);
    await new Promise((r) => setTimeout(r, wait));
  }
  _lastRequest = Date.now();
}

// ---------------------------------------------------------------------------
// Retry helper (429, 500, 502, 503)
// ---------------------------------------------------------------------------
const RETRYABLE   = new Set([429, 500, 502, 503]);
const MAX_RETRIES = 4;
const BASE_DELAY  = 1_000;

async function withRetry(fn, label = 'brave') {
  let attempt = 0;
  while (true) {
    try {
      await throttle();
      return await fn();
    } catch (err) {
      const status = err.response?.status;
      attempt += 1;
      if (!RETRYABLE.has(status) || attempt >= MAX_RETRIES) {
        log.error(`${label} failed (status=${status}, attempts=${attempt}): ${err.message}`);
        throw err;
      }
      const delay = BASE_DELAY * 2 ** (attempt - 1) + Math.random() * 300;
      log.warn(`Retryable ${status} on ${label}, attempt ${attempt}/${MAX_RETRIES}, backoff ${Math.round(delay)}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// ---------------------------------------------------------------------------
// Utility: strip HTML tags, truncate
// ---------------------------------------------------------------------------
function stripHtml(str) {
  if (!str) return '';
  return str.replace(/<[^>]*>/g, '').replace(/&[a-z]+;/gi, ' ').trim();
}

function truncate(str, max = 200) {
  if (!str || str.length <= max) return str || '';
  return str.slice(0, max).replace(/\s+\S*$/, '') + '…';
}

function cleanResult(r) {
  return {
    title:       stripHtml(r.title),
    url:         r.url,
    description: truncate(stripHtml(r.description), 200),
    age:         r.age || null,
  };
}

// ---------------------------------------------------------------------------
// BraveSearchClient
// ---------------------------------------------------------------------------
export class BraveSearchClient {
  constructor(apiKey) {
    if (!apiKey) {
      throw new Error('BraveSearchClient requires an API key');
    }
    this.http = axios.create({
      baseURL: BASE_URL,
      headers: {
        'X-Subscription-Token': apiKey,
        Accept: 'application/json',
      },
      timeout: 15_000,
    });
    log.info('BraveSearchClient initialised');
  }

  // ---- Core search --------------------------------------------------------

  /**
   * Web search.
   * @param {string} query
   * @param {object} [opts] - { count?, offset?, country?, freshness? }
   */
  async search(query, opts = {}) {
    return withRetry(async () => {
      const res = await this.http.get('', {
        params: {
          q: query,
          count: opts.count || 10,
          offset: opts.offset || 0,
          country: opts.country || undefined,
          freshness: opts.freshness || undefined,
        },
      });
      const web = res.data?.web?.results || [];
      return web.map(cleanResult);
    }, 'search');
  }

  /**
   * News-focused search (uses freshness filter).
   */
  async searchNews(query, opts = {}) {
    return this.search(query, {
      ...opts,
      freshness: opts.freshness || 'pw', // past week
      count: opts.count || 10,
    });
  }

  /**
   * Search and return a short summarised answer.
   * Uses the Brave summarizer flag when available, otherwise returns top results.
   */
  async summarize(query) {
    return withRetry(async () => {
      const res = await this.http.get('', {
        params: {
          q: query,
          count: 5,
          summary: 1,
        },
      });

      // If Brave returned a summarizer answer, prefer that.
      if (res.data?.summarizer?.key) {
        return {
          summary: stripHtml(res.data.summarizer.key),
          results: (res.data?.web?.results || []).map(cleanResult),
        };
      }

      // Fallback: concatenate top descriptions
      const results = (res.data?.web?.results || []).map(cleanResult);
      const summary = results
        .slice(0, 3)
        .map((r) => r.description)
        .join(' ');

      return { summary, results };
    }, 'summarize');
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
let _instance = null;

export function createBraveSearchClient() {
  if (_instance) return _instance;
  const key = integrationConfig.braveSearch?.apiKey;
  if (!key) {
    log.info('BraveSearch: no API key — client disabled');
    return null;
  }
  _instance = new BraveSearchClient(key);
  return _instance;
}

export default BraveSearchClient;
