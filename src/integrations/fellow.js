// src/integrations/fellow.js
// Fellow API v1 client for Razor.

import axios from 'axios';
import makeLogger from '../utils/logger.js';
import { integrationConfig } from './config.js';

const log = makeLogger('Fellow');

const BASE_URL = 'https://api.fellow.app/api/v1/';

// ---------------------------------------------------------------------------
// Retry helper (429, 500, 502, 503)
// ---------------------------------------------------------------------------
const RETRYABLE   = new Set([429, 500, 502, 503]);
const MAX_RETRIES = 4;
const BASE_DELAY  = 600;

async function withRetry(fn, label = 'fellow') {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      const status = err.response?.status;
      attempt += 1;
      if (!RETRYABLE.has(status) || attempt >= MAX_RETRIES) {
        log.error(`${label} failed (status=${status}, attempts=${attempt}): ${err.message}`);
        throw err;
      }
      const delay = BASE_DELAY * 2 ** (attempt - 1) + Math.random() * 200;
      log.warn(`Retryable ${status} on ${label}, attempt ${attempt}/${MAX_RETRIES}, backoff ${Math.round(delay)}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// ---------------------------------------------------------------------------
// FellowClient
// ---------------------------------------------------------------------------
export class FellowClient {
  constructor(apiKey) {
    if (!apiKey) {
      throw new Error('FellowClient requires an API key');
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
    log.info('FellowClient initialised');
  }

  // ---- Internal helpers ---------------------------------------------------

  async _get(path, params = {}) {
    return withRetry(() => this.http.get(path, { params }), `GET ${path}`);
  }

  /**
   * Paginate through a Fellow list endpoint.
   * Fellow uses cursor / offset-based pagination depending on the endpoint.
   * We assume offset+limit here; adjust if Fellow switches to cursor.
   */
  async _paginate(path, params = {}, maxPages = 10) {
    const all = [];
    let offset = params.offset || 0;
    const limit = params.limit || 25;

    for (let i = 0; i < maxPages; i++) {
      const res = await this._get(path, { ...params, offset, limit });
      const items = res.data?.data ?? res.data?.results ?? [];
      all.push(...items);

      // If fewer items than limit → we've hit the last page
      if (items.length < limit) break;
      offset += limit;
    }
    return all;
  }

  // ---- Meetings -----------------------------------------------------------

  /**
   * List meetings.
   * @param {object} opts - { from?, to?, limit? }
   *   from/to are ISO date strings.
   */
  async getMeetings(opts = {}) {
    const params = {};
    if (opts.from) params.from = opts.from;
    if (opts.to)   params.to   = opts.to;
    if (opts.limit) params.limit = opts.limit;
    return this._paginate('meetings', params);
  }

  /**
   * Get notes attached to a meeting.
   */
  async getMeetingNotes(meetingId) {
    const res = await this._get(`meetings/${meetingId}/notes`);
    return res.data?.data ?? res.data;
  }

  // ---- Action Items -------------------------------------------------------

  /**
   * List action items.
   * @param {object} opts - { status?, assignee?, limit? }
   */
  async getActionItems(opts = {}) {
    const params = {};
    if (opts.status)   params.status   = opts.status;
    if (opts.assignee) params.assignee = opts.assignee;
    if (opts.limit)    params.limit    = opts.limit;
    return this._paginate('action-items', params);
  }

  // ---- Search -------------------------------------------------------------

  /**
   * Search meeting notes.
   * @param {string} query
   */
  async searchNotes(query) {
    const res = await this._get('search', { q: query, type: 'notes' });
    return res.data?.data ?? res.data?.results ?? [];
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
let _instance = null;

export function createFellowClient() {
  if (_instance) return _instance;
  const key = integrationConfig.fellow?.apiKey;
  if (!key) {
    log.info('Fellow: no API key — client disabled');
    return null;
  }
  _instance = new FellowClient(key);
  return _instance;
}

export default FellowClient;
