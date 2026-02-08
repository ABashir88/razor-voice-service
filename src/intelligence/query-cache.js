// src/intelligence/query-cache.js — Query result cache with TTL + predictive prefetch
//
// Caches integration query results to avoid redundant API calls.
// Tracks usage patterns and predictively prefetches common queries.
//
// Usage:
//   import { queryCache } from './query-cache.js';
//   const cached = queryCache.get('check_calendar');
//   if (cached) return cached;
//   const result = await integrations.getUpcomingSchedule(7);
//   queryCache.set('check_calendar', result, 300_000); // 5 min TTL

import EventEmitter from 'eventemitter3';
import makeLogger from '../utils/logger.js';

const log = makeLogger('QueryCache');

// Default TTLs by action category (ms)
const DEFAULT_TTLS = {
  // Calendar: 5 minutes (events don't change that fast)
  check_calendar: 300_000,
  get_schedule: 300_000,
  get_upcoming_events: 300_000,

  // Email: 2 minutes (new emails arrive)
  check_email: 120_000,
  get_unread_emails: 120_000,

  // Salesforce: 10 minutes (pipeline doesn't change mid-conversation)
  get_pipeline: 600_000,
  get_stale_deals: 600_000,
  get_deals_closing: 600_000,
  get_biggest_deal: 600_000,
  get_sf_tasks: 600_000,

  // Salesloft: 5 minutes
  get_hot_leads: 300_000,
  get_email_opens: 300_000,
  get_activity_stats: 300_000,

  // Fellow: 10 minutes
  get_action_items: 600_000,
  last_meeting: 600_000,
  get_today_meetings: 600_000,

  // Contact lookup: 30 minutes (contacts rarely change)
  lookup_contact: 1_800_000,
  lookup_account: 1_800_000,
};

// Default TTL for unknown actions
const FALLBACK_TTL = 120_000; // 2 minutes

class QueryCache extends EventEmitter {
  constructor() {
    super();
    this._cache = new Map();    // key → { data, expiresAt }
    this._usage = new Map();    // action → { count, lastUsedAt, times: number[] }
    this._prefetchCallbacks = new Map(); // action → async () => data
  }

  /**
   * Build cache key from action + params.
   */
  _key(action, params = {}) {
    const paramStr = Object.entries(params)
      .filter(([, v]) => v != null)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    return paramStr ? `${action}:${paramStr}` : action;
  }

  /**
   * Get cached result, or null if expired/missing.
   */
  get(action, params = {}) {
    const key = this._key(action, params);
    const entry = this._cache.get(key);

    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this._cache.delete(key);
      return null;
    }

    log.debug(`Cache HIT: ${key} (${Math.round((entry.expiresAt - Date.now()) / 1000)}s remaining)`);
    return entry.data;
  }

  /**
   * Store a result in the cache.
   * @param {string} action
   * @param {*} data — The result data
   * @param {number} [ttlMs] — Override TTL (uses default for action type if omitted)
   */
  set(action, data, ttlMs, params = {}) {
    if (data == null) return;

    const key = this._key(action, params);
    const ttl = ttlMs || DEFAULT_TTLS[action] || FALLBACK_TTL;

    this._cache.set(key, {
      data,
      expiresAt: Date.now() + ttl,
    });

    // Track usage pattern
    this._trackUsage(action);

    log.debug(`Cache SET: ${key} (TTL: ${Math.round(ttl / 1000)}s)`);
  }

  /**
   * Invalidate a specific cache entry.
   */
  invalidate(action, params = {}) {
    const key = this._key(action, params);
    this._cache.delete(key);
  }

  /**
   * Clear all cached data.
   */
  clear() {
    this._cache.clear();
    log.info('Cache cleared');
  }

  /**
   * Track that an action was requested (for prefetch prediction).
   */
  _trackUsage(action) {
    const now = Date.now();
    let usage = this._usage.get(action);
    if (!usage) {
      usage = { count: 0, lastUsedAt: 0, times: [] };
      this._usage.set(action, usage);
    }
    usage.count++;
    usage.lastUsedAt = now;
    usage.times.push(now);

    // Keep last 20 timestamps
    if (usage.times.length > 20) {
      usage.times = usage.times.slice(-20);
    }
  }

  /**
   * Register a prefetch callback for an action.
   * Called when predictive prefetch decides to warm the cache.
   * @param {string} action
   * @param {Function} fetchFn — async () => data
   */
  registerPrefetch(action, fetchFn) {
    this._prefetchCallbacks.set(action, fetchFn);
  }

  /**
   * Run predictive prefetch: warm cache for frequently-used actions.
   * Call this at natural points (e.g., after wake word, morning startup).
   */
  async prefetch() {
    const now = Date.now();
    const candidates = [];

    for (const [action, usage] of this._usage.entries()) {
      // Skip if already cached
      if (this._cache.has(action)) continue;

      // Skip if no prefetch callback registered
      if (!this._prefetchCallbacks.has(action)) continue;

      // Score: higher count + recent usage = better candidate
      const recency = Math.max(0, 1 - (now - usage.lastUsedAt) / 3_600_000); // 0-1, decays over 1 hour
      const frequency = Math.min(usage.count / 5, 1); // 0-1, saturates at 5 uses
      const score = frequency * 0.6 + recency * 0.4;

      if (score > 0.3) {
        candidates.push({ action, score });
      }
    }

    // Sort by score, prefetch top 3
    candidates.sort((a, b) => b.score - a.score);
    const toPrefetch = candidates.slice(0, 3);

    if (toPrefetch.length === 0) return;

    log.info(`Prefetching ${toPrefetch.length} queries: ${toPrefetch.map(c => c.action).join(', ')}`);

    await Promise.allSettled(
      toPrefetch.map(async ({ action }) => {
        const fetchFn = this._prefetchCallbacks.get(action);
        try {
          const data = await fetchFn();
          if (data != null) {
            this.set(action, data);
            log.debug(`Prefetched: ${action}`);
          }
        } catch (err) {
          log.debug(`Prefetch failed for ${action}: ${err.message}`);
        }
      }),
    );
  }

  /**
   * Get cache stats.
   */
  stats() {
    let active = 0;
    const now = Date.now();
    for (const entry of this._cache.values()) {
      if (entry.expiresAt > now) active++;
    }
    return {
      entries: this._cache.size,
      active,
      trackedActions: this._usage.size,
    };
  }
}

// Singleton
export const queryCache = new QueryCache();
export default queryCache;
