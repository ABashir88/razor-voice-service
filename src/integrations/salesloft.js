// src/integrations/salesloft.js
// Salesloft REST v2 client for Razor.

import axios from 'axios';
import makeLogger from '../utils/logger.js';
import { integrationConfig } from './config.js';

const log = makeLogger('Salesloft');

const BASE_URL = 'https://api.salesloft.com/v2/';

// ---------------------------------------------------------------------------
// Token-bucket rate limiter (600 requests / 60 s)
// ---------------------------------------------------------------------------
class TokenBucket {
  constructor(capacity, refillRate) {
    this.capacity   = capacity;
    this.tokens     = capacity;
    this.refillRate = refillRate; // tokens per ms
    this.lastRefill = Date.now();
  }

  _refill() {
    const now   = Date.now();
    const delta = now - this.lastRefill;
    this.tokens = Math.min(this.capacity, this.tokens + delta * this.refillRate);
    this.lastRefill = now;
  }

  async acquire() {
    this._refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    // Wait until 1 token is available
    const waitMs = Math.ceil((1 - this.tokens) / this.refillRate);
    log.warn(`Rate limit: waiting ${waitMs}ms for token`);
    await new Promise((r) => setTimeout(r, waitMs));
    this._refill();
    this.tokens -= 1;
  }
}

// 600 per 60 000 ms → 0.01 tokens/ms
const bucket = new TokenBucket(600, 600 / 60_000);

// ---------------------------------------------------------------------------
// Retry helper (429, 500, 502, 503)
// ---------------------------------------------------------------------------
const RETRYABLE = new Set([429, 500, 502, 503]);
const MAX_RETRIES  = 5;
const BASE_DELAY   = 500; // ms

async function retryRequest(fn) {
  let attempt = 0;
  while (true) {
    try {
      await bucket.acquire();
      return await fn();
    } catch (err) {
      const status = err.response?.status;
      attempt += 1;
      if (!RETRYABLE.has(status) || attempt >= MAX_RETRIES) {
        log.error(`Request failed (status=${status}, attempts=${attempt}): ${err.message}`);
        throw err;
      }
      const delay = BASE_DELAY * 2 ** (attempt - 1) + Math.random() * 200;
      log.warn(`Retryable ${status}, attempt ${attempt}/${MAX_RETRIES}, backoff ${Math.round(delay)}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// ---------------------------------------------------------------------------
// SalesloftClient
// ---------------------------------------------------------------------------
export class SalesloftClient {
  constructor(apiKey) {
    if (!apiKey) {
      throw new Error('SalesloftClient requires an API key');
    }
    this.http = axios.create({
      baseURL: BASE_URL,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      timeout: 15_000,
    });
    log.info('SalesloftClient initialised');
  }

  // ---- internal helpers ---------------------------------------------------

  /** Single request with retry + rate limiting. */
  async _get(path, params = {}) {
    return retryRequest(() => this.http.get(path, { params }));
  }

  async _post(path, body = {}) {
    return retryRequest(() => this.http.post(path, body));
  }

  /**
   * Auto-paginate a list endpoint.
   * Returns all `data` items across pages.
   * @param {string} path
   * @param {object} params  - query params (page, per_page, etc.)
   * @param {number} [maxPages=10] - safety cap
   */
  async _paginate(path, params = {}, maxPages = 10) {
    const allItems = [];
    let page = params.page || 1;
    const perPage = params.per_page || 25;

    for (let i = 0; i < maxPages; i++) {
      const res = await this._get(path, { ...params, page, per_page: perPage });
      const items = res.data?.data ?? [];
      allItems.push(...items);

      const meta = res.data?.metadata?.paging;
      if (!meta || page >= (meta.total_pages ?? page)) break;
      page += 1;
    }

    return allItems;
  }

  // ---- People -------------------------------------------------------------

  /** Search / list people. */
  async getPeople(query = {}) {
    const params = typeof query === 'string'
      ? { email_addresses: query }
      : query;
    return this._paginate('people.json', params);
  }

  /** Get a single person by ID. */
  async getPerson(id) {
    const res = await this._get(`people/${id}.json`);
    return res.data?.data ?? res.data;
  }

  // ---- Activities ---------------------------------------------------------

  /** Activities for a person (calls, emails, etc.). */
  async getActivities(personId, opts = {}) {
    return this._paginate('activities/calls.json', {
      ...opts,
      person_id: personId,
    });
  }

  // ---- Cadences -----------------------------------------------------------

  async getCadences() {
    return this._paginate('cadences.json');
  }

  async getCadenceSteps(cadenceId) {
    return this._paginate('steps.json', { cadence_id: cadenceId });
  }

  // ---- Logging interactions -----------------------------------------------

  /**
   * Log a completed call.
   * @param {number} personId
   * @param {object} data - { disposition, duration, notes, ... }
   */
  async logCall(personId, data = {}) {
    const body = {
      person_id: personId,
      disposition: data.disposition || 'connected',
      duration: data.duration || 0,
      notes: data.notes || '',
      ...data,
    };
    const res = await this._post('activities/calls.json', body);
    log.info(`Logged call for person ${personId}`);
    return res.data?.data ?? res.data;
  }

  /**
   * Log an email.
   * @param {number} personId
   * @param {object} data - { subject, body, ... }
   */
  async logEmail(personId, data = {}) {
    const body = {
      person_id: personId,
      subject: data.subject || '',
      body: data.body || '',
      ...data,
    };
    const res = await this._post('activities/emails.json', body);
    log.info(`Logged email for person ${personId}`);
    return res.data?.data ?? res.data;
  }

  // ---- Accounts -----------------------------------------------------------

  async getAccounts(query = {}) {
    const params = typeof query === 'string'
      ? { company_name: query }
      : query;
    return this._paginate('accounts.json', params);
  }

  async getAccount(id) {
    const res = await this._get(`accounts/${id}.json`);
    return res.data?.data ?? res.data;
  }

  // ---- Opportunities ------------------------------------------------------

  async getOpportunities(accountId) {
    return this._paginate('opportunities.json', { account_id: accountId });
  }
}

// ---------------------------------------------------------------------------
// Convenience factory — returns null when not configured (never throws).
// ---------------------------------------------------------------------------
let _instance = null;

export function createSalesloftClient() {
  if (_instance) return _instance;
  const key = integrationConfig.salesloft?.apiKey;
  if (!key) {
    log.info('Salesloft: no API key — client disabled');
    return null;
  }
  _instance = new SalesloftClient(key);
  return _instance;
}

export default SalesloftClient;
