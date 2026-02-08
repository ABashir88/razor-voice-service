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
    this._myUserId = 89440; // Alrazi Bashir
    log.info('SalesloftClient initialised (user_id=89440)');
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

  // ---- Hot Leads & Engagement ---------------------------------------------

  /**
   * Get hot leads — people with the most email engagement (views, clicks, replies).
   * Uses people endpoint counts (fast, no activity scanning).
   */
  async getHotLeads() {
    try {
      log.info('Fetching hot leads…');
      const people = await this._paginate('people.json', { owner_id: this._myUserId, per_page: 50 }, 1);

      const engaged = people.filter(p =>
        p.hot_lead || p.counts?.emails_viewed > 0 || p.counts?.emails_clicked > 0 || p.counts?.emails_replied_to > 0
      );

      engaged.sort((a, b) => {
        const scoreA = (a.counts?.emails_clicked || 0) * 3 + (a.counts?.emails_replied_to || 0) * 5 + (a.counts?.emails_viewed || 0);
        const scoreB = (b.counts?.emails_clicked || 0) * 3 + (b.counts?.emails_replied_to || 0) * 5 + (b.counts?.emails_viewed || 0);
        return scoreB - scoreA;
      });

      const result = engaged.slice(0, 5).map(p => ({
        id: p.id,
        name: p.display_name,
        first_name: p.first_name,
        last_name: p.last_name,
        company: p.person_company_name,
        views: p.counts?.emails_viewed || 0,
        clicks: p.counts?.emails_clicked || 0,
        replies: p.counts?.emails_replied_to || 0,
        hot: p.hot_lead || false,
      }));

      log.info(`Hot leads: ${result.length} engaged from ${people.length} people`);
      return result;
    } catch (error) {
      log.error('[Salesloft] getHotLeads error:', error.message);
      throw error;
    }
  }

  /** People who opened emails, sorted by view count. */
  async getEmailOpens() {
    try {
      const people = await this._paginate('people.json', { owner_id: this._myUserId, per_page: 50 }, 1);
      return people
        .filter(p => p.counts?.emails_viewed > 0)
        .sort((a, b) => b.counts.emails_viewed - a.counts.emails_viewed)
        .slice(0, 10)
        .map(p => ({ name: p.display_name, company: p.person_company_name, views: p.counts.emails_viewed }));
    } catch (error) {
      log.error('[Salesloft] getEmailOpens error:', error.message);
      throw error;
    }
  }

  /** People who clicked email links, sorted by click count. */
  async getEmailClicks() {
    try {
      const people = await this._paginate('people.json', { owner_id: this._myUserId, per_page: 50 }, 1);
      return people
        .filter(p => p.counts?.emails_clicked > 0)
        .sort((a, b) => b.counts.emails_clicked - a.counts.emails_clicked)
        .slice(0, 10)
        .map(p => ({ name: p.display_name, company: p.person_company_name, clicks: p.counts.emails_clicked }));
    } catch (error) {
      log.error('[Salesloft] getEmailClicks error:', error.message);
      throw error;
    }
  }

  /** People who replied, sorted by reply count. */
  async getReplies() {
    try {
      const people = await this._paginate('people.json', { owner_id: this._myUserId, per_page: 50 }, 1);
      return people
        .filter(p => p.counts?.emails_replied_to > 0)
        .sort((a, b) => b.counts.emails_replied_to - a.counts.emails_replied_to)
        .slice(0, 10)
        .map(p => ({ name: p.display_name, company: p.person_company_name, replies: p.counts.emails_replied_to }));
    } catch (error) {
      log.error('[Salesloft] getReplies error:', error.message);
      throw error;
    }
  }

  /** Aggregate activity stats across all owned people. */
  async getActivityStats() {
    try {
      const people = await this._paginate('people.json', { owner_id: this._myUserId, per_page: 100 }, 1);
      let totalEmails = 0;
      let totalCalls = 0;
      for (const p of people) {
        totalEmails += p.counts?.emails_sent || 0;
        totalCalls += p.counts?.calls || 0;
      }
      return { emails: totalEmails, calls: totalCalls, people: people.length };
    } catch (error) {
      log.error('[Salesloft] getActivityStats error:', error.message);
      throw error;
    }
  }

  // ---- Cadences -----------------------------------------------------------

  /** List all cadences (org-wide). */
  async getCadences() {
    const cadences = await this._paginate('cadences.json', { per_page: 50 });
    return cadences.map(c => ({
      id: c.id,
      name: c.name,
      state: c.current_state,
      peopleCount: c.counts?.cadence_people || 0,
    }));
  }

  /** List cadences owned by this user. */
  async getMyCadences() {
    try {
      const cadences = await this._paginate('cadences.json', { owner_id: this._myUserId, per_page: 20 });
      return cadences.map(c => ({
        id: c.id,
        name: c.name,
        state: c.current_state,
        peopleCount: c.counts?.cadence_people || 0,
      }));
    } catch (error) {
      log.error('[Salesloft] getMyCadences error:', error.message);
      throw error;
    }
  }

  /** Get cadence steps for a specific cadence. */
  async getCadenceSteps(cadenceId) {
    return this._paginate('steps.json', { cadence_id: cadenceId });
  }

  /** Find which cadences a person is on. */
  async getCadencesForPerson(personName) {
    const person = await this.findPersonByName(personName);
    if (!person) return { person: null, cadences: [] };

    const memberships = await this._paginate('cadence_memberships.json', { person_id: person.id, per_page: 20 });
    const cadenceIds = memberships.map(m => m.cadence?.id).filter(Boolean);
    const allCadences = await this.getCadences();
    const personCadences = allCadences.filter(c => cadenceIds.includes(c.id));

    return {
      person: { id: person.id, name: person.name },
      cadences: personCadences,
      activeMemberships: memberships.filter(m => m.currently_on_cadence),
    };
  }

  /** Find a person by name (fuzzy match within owned people). */
  async findPersonByName(name) {
    const people = await this._paginate('people.json', { owner_id: this._myUserId, per_page: 50 }, 1);
    const lower = name.toLowerCase();
    const person = people.find(p => (p.display_name || '').toLowerCase().includes(lower));
    if (!person) return null;
    return {
      id: person.id,
      name: person.display_name,
      email: person.email_address,
      company: person.person_company_name,
    };
  }

  /** Find an active cadence by name (fuzzy match). */
  async findCadenceByName(name) {
    const cadences = await this._paginate('cadences.json', { per_page: 50 });
    const lower = name.toLowerCase();
    const cadence = cadences.find(c =>
      (c.name || '').toLowerCase().includes(lower) && c.current_state === 'active'
    );
    if (!cadence) return null;
    return { id: cadence.id, name: cadence.name };
  }

  /**
   * Add a person to a cadence by name.
   * Looks up both person and cadence, then creates membership.
   */
  async addToCadence(personName, cadenceName) {
    const person = await this.findPersonByName(personName);
    if (!person) return { success: false, error: `Person "${personName}" not found` };

    const cadence = await this.findCadenceByName(cadenceName);
    if (!cadence) return { success: false, error: `Cadence "${cadenceName}" not found` };

    try {
      await this._post('cadence_memberships.json', {
        person_id: person.id,
        cadence_id: cadence.id,
        user_id: this._myUserId,
      });
      log.info(`Added ${person.name} to cadence "${cadence.name}"`);
      return { success: true, person: person.name, cadence: cadence.name };
    } catch (err) {
      log.error(`Failed to add to cadence: ${err.message}`);
      return { success: false, error: err.message };
    }
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
