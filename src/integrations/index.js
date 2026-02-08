// src/integrations/index.js
// Integration Manager — unified coordinator for all Razor integrations.

import EventEmitter from 'eventemitter3';
import makeLogger from '../utils/logger.js';
import { getEnabledIntegrations } from './config.js';
import { createSalesloftClient } from './salesloft.js';
import { createSalesforceClient } from './salesforce.js';
import { createGoogleClient } from './google.js';
import { createFellowClient } from './fellow-mcp.js';
import { createBraveSearchClient } from './brave-search.js';

const log = makeLogger('IntegrationManager');

// ---------------------------------------------------------------------------
// Helper: run an async fn, swallow errors from unconfigured / broken services.
// Returns null on failure so callers can use ?. or filter.
// ---------------------------------------------------------------------------
async function safe(label, fn) {
  try {
    return await fn();
  } catch (err) {
    log.warn(`[${label}] ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// TTL cache — reduces redundant API calls for slowly-changing data.
// ---------------------------------------------------------------------------
class TtlCache {
  constructor() {
    this._store = new Map();
  }

  get(key) {
    const entry = this._store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this._store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value, ttlMs) {
    this._store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  invalidate(key) {
    this._store.delete(key);
  }

  clear() {
    this._store.clear();
  }
}

/** Cache TTLs in milliseconds */
const CACHE_TTL = {
  contactContext:    5 * 60_000,   // 5 min
  accountBrief:     5 * 60_000,   // 5 min
  hotLeads:        10 * 60_000,   // 10 min
  upcomingSchedule:  2 * 60_000,  // 2 min
  pipeline:          5 * 60_000,  // 5 min
};

// ---------------------------------------------------------------------------
// IntegrationManager
// ---------------------------------------------------------------------------
export class IntegrationManager extends EventEmitter {
  constructor() {
    super();
    this.salesloft  = null;
    this.salesforce = null;
    this.google     = null;
    this.fellow     = null;
    this.brave      = null;
    this._initialized = false;
    this._cache = new TtlCache();
  }

  // ---- Lifecycle ----------------------------------------------------------

  /**
   * Instantiate every configured client. Salesforce requires an async login()
   * so we await it here; every other client is synchronous construction.
   */
  async initialize() {
    log.info('Initialising integrations…');
    const enabled = getEnabledIntegrations();

    // -- Salesloft
    if (enabled.includes('salesloft')) {
      this.salesloft = createSalesloftClient();
      if (this.salesloft) this._emitReady('salesloft');
    }

    // -- Salesforce (async login)
    if (enabled.includes('salesforce')) {
      this.salesforce = createSalesforceClient();
      if (this.salesforce) {
        try {
          await this.salesforce.login();
          this._emitReady('salesforce');
        } catch (err) {
          log.error(`Salesforce login failed: ${err.message}`);
          this.emit('integration:error', { service: 'salesforce', error: err });
          this.salesforce = null; // disable after failed login
        }
      }
    }

    // -- Google
    if (enabled.includes('google')) {
      this.google = createGoogleClient();
      if (this.google) this._emitReady('google');
    }

    // -- Fellow
    if (enabled.includes('fellow')) {
      this.fellow = createFellowClient();
      if (this.fellow) this._emitReady('fellow');
    }

    // -- Brave Search
    if (enabled.includes('braveSearch')) {
      this.brave = createBraveSearchClient();
      if (this.brave) this._emitReady('braveSearch');
    }

    this._initialized = true;
    const live = this._liveServices();
    log.info(`Initialisation complete — live services: ${live.join(', ') || '(none)'}`);
    return live;
  }

  _liveServices() {
    const m = [];
    if (this.salesloft)  m.push('salesloft');
    if (this.salesforce) m.push('salesforce');
    if (this.google)     m.push('google');
    if (this.fellow)     m.push('fellow');
    if (this.brave)      m.push('braveSearch');
    return m;
  }

  _emitReady(service) {
    log.info(`${service}: ready`);
    this.emit('integration:ready', { service });
  }

  _emitAction(action, service, detail = {}) {
    this.emit('integration:action_completed', { action, service, ...detail });
  }

  // =========================================================================
  // High-level orchestrations
  // =========================================================================

  /**
   * Gather everything we know about a contact across all services.
   * Returns a merged context object.
   */
  async getContactContext(name) {
    const cacheKey = `contact:${name.toLowerCase()}`;
    const cached = this._cache.get(cacheKey);
    if (cached) { log.debug(`Cache hit: ${cacheKey}`); return cached; }

    log.info(`Building contact context for "${name}"`);

    const [sfContacts, slPeople, emails, meetings] = await Promise.all([
      safe('sf.searchContacts', () => this.salesforce?.searchContacts(name)),
      safe('sl.getPeople', () => this.salesloft?.getPeople(name)),
      safe('gmail.search', () => this.google?.getRecentEmails(`from:${name} OR to:${name}`, 5)),
      safe('fellow.search', () => this.fellow?.searchNotes(name)),
    ]);

    const context = {
      salesforce: sfContacts || [],
      salesloft:  slPeople   || [],
      recentEmails: emails   || [],
      meetingNotes: meetings || [],
    };

    this._cache.set(cacheKey, context, CACHE_TTL.contactContext);
    this._emitAction('getContactContext', 'multi', { name });
    return context;
  }

  /**
   * Log a call / email across Salesforce + Salesloft simultaneously.
   */
  async logInteraction(contactId, data = {}) {
    log.info(`Logging interaction for contact ${contactId}`);

    const results = {};

    // Salesforce task
    results.salesforce = await safe('sf.logActivity', () =>
      this.salesforce?.logActivity(contactId, data.whatId || null, {
        subject: data.subject || data.type || 'Call',
        description: data.notes || '',
        duration: data.duration || null,
        disposition: data.disposition || null,
        subtype: data.type || 'Call',
      }),
    );

    // Salesloft activity
    if (data.salesloftPersonId) {
      const slFn = data.type === 'email'
        ? () => this.salesloft?.logEmail(data.salesloftPersonId, data)
        : () => this.salesloft?.logCall(data.salesloftPersonId, data);
      results.salesloft = await safe('sl.logInteraction', slFn);
    }

    this._emitAction('logInteraction', 'multi', { contactId });
    return results;
  }

  /**
   * Upcoming meetings + tasks for the next N days.
   */
  async getUpcomingSchedule(days = 7) {
    const cacheKey = `schedule:${days}`;
    const cached = this._cache.get(cacheKey);
    if (cached) { log.debug(`Cache hit: ${cacheKey}`); return cached; }

    log.info(`Fetching schedule for next ${days} days`);

    const [events, tasks, meetings] = await Promise.all([
      safe('gcal.upcoming', () => this.google?.getUpcomingEvents(days)),
      safe('sf.tasks', () => {
        // We need an ownerId; if we don't have one this will be null.
        // Callers can provide it via a prior SF identity call.
        return null;
      }),
      safe('fellow.meetings', () => {
        const from = new Date().toISOString();
        const to   = new Date(Date.now() + days * 86_400_000).toISOString();
        return this.fellow?.getTodaysMeetings();
      }),
    ]);

    const schedule = {
      calendarEvents:  events   || [],
      salesforceTasks: tasks    || [],
      fellowMeetings:  meetings || [],
    };

    this._cache.set(cacheKey, schedule, CACHE_TTL.upcomingSchedule);
    return schedule;
  }

  /**
   * Research a topic using Brave Search.
   */
  async research(query) {
    log.info(`Researching: "${query}"`);

    if (!this.brave) {
      log.warn('Brave Search not configured — skipping research');
      return { summary: null, results: [] };
    }

    const result = await safe('brave.summarize', () =>
      this.brave.summarize(query),
    );

    this._emitAction('research', 'braveSearch', { query });
    return result || { summary: null, results: [] };
  }

  /**
   * Draft or send a follow-up email via Gmail.
   */
  async sendFollowUp(opts = {}) {
    if (!this.google) {
      log.warn('Google not configured — cannot send follow-up');
      return null;
    }

    const fn = opts.draft
      ? () => this.google.draftEmail(opts)
      : () => this.google.sendEmail(opts);

    const result = await safe('gmail.followUp', fn);
    this._emitAction('sendFollowUp', 'google', { to: opts.to });
    return result;
  }

  /**
   * Hot leads — people with the most email engagement (opens, clicks, replies).
   */
  async getHotLeads(opts = {}) {
    if (!this.salesloft) {
      log.warn('Salesloft not configured — cannot fetch hot leads');
      return [];
    }
    const cacheKey = 'hotLeads';
    const cached = this._cache.get(cacheKey);
    if (cached) { log.debug(`Cache hit: ${cacheKey}`); return cached; }

    const result = await safe('sl.getHotLeads', () => this.salesloft.getHotLeads(opts));
    const leads = result || [];
    this._cache.set(cacheKey, leads, CACHE_TTL.hotLeads);
    this._emitAction('getHotLeads', 'salesloft');
    return leads;
  }

  /**
   * Full account brief: Salesforce account + opportunities + Salesloft activities + web research.
   */
  async getFullAccountBrief(accountName) {
    const cacheKey = `account:${accountName.toLowerCase()}`;
    const cached = this._cache.get(cacheKey);
    if (cached) { log.debug(`Cache hit: ${cacheKey}`); return cached; }

    log.info(`Building account brief for "${accountName}"`);

    // Step 1: Find the account in Salesforce or Salesloft
    const [sfAccounts, slAccounts] = await Promise.all([
      safe('sf.query', () =>
        this.salesforce?.query(
          `SELECT Id, Name, Industry, Website, AnnualRevenue, NumberOfEmployees, Description
           FROM Account WHERE Name LIKE '%${accountName.replace(/'/g, "\\'")}%' LIMIT 5`,
        ),
      ),
      safe('sl.getAccounts', () => this.salesloft?.getAccounts(accountName)),
    ]);

    const sfAccount = sfAccounts?.[0] || null;

    // Step 2: In parallel — opps, research
    const [opportunities, research] = await Promise.all([
      sfAccount?.Id
        ? safe('sf.opps', () => this.salesforce?.getOpportunitiesByAccount(sfAccount.Id))
        : null,
      safe('brave.research', () => this.brave?.search(`${accountName} company news`, { count: 5 })),
    ]);

    const brief = {
      account:       sfAccount,
      salesloft:     slAccounts?.[0] || null,
      opportunities: opportunities || [],
      news:          research || [],
    };

    this._cache.set(cacheKey, brief, CACHE_TTL.accountBrief);
    this._emitAction('getFullAccountBrief', 'multi', { accountName });
    return brief;
  }

  /**
   * Look up a specific deal by name.
   * Searches Opportunity name and Account name in Salesforce.
   * @param {string} name - Deal or account name to search.
   * @returns {string} Humanized deal summary for voice response.
   */
  async getDealByName(name) {
    if (!name) return 'Which deal do you want to know about?';
    if (!this.salesforce) return 'Salesforce not connected.';

    log.info(`Looking up deal: "${name}"`);

    const deal = await safe('sf.getDealByName', () =>
      this.salesforce.getDealByName(name),
    );

    if (!deal) return `Couldn't find a deal matching "${name}".`;

    this._emitAction('getDealByName', 'salesforce', { name });
    return `${deal.name}: ${deal.amount || 'no amount'}, stage: ${deal.stage || 'unknown'}, ` +
           `closes ${deal.closeDate || 'unknown'}, last activity: ${deal.lastActivity || 'unknown'}.`;
  }

  /**
   * Get deals closing within the next N days.
   * @param {number} [days=7]
   * @returns {string} Humanized summary for voice response.
   */
  async getDealsClosingSoon(days = 7) {
    if (!this.salesforce) return 'Salesforce not connected.';

    log.info(`Fetching deals closing in next ${days} days`);

    const deals = await safe('sf.getDealsClosingSoon', () =>
      this.salesforce.getDealsClosingSoon(days),
    );

    if (!deals || deals.length === 0) {
      return `No deals closing in the next ${days} days.`;
    }

    const summary = deals.slice(0, 3).map((d) =>
      `${d.name}: ${d.amount}, closes ${d.closeDate}`,
    ).join('. ');

    this._emitAction('getDealsClosingSoon', 'salesforce', { days });
    return `${deals.length} deal${deals.length === 1 ? '' : 's'} closing soon. ${summary}.`;
  }

  /**
   * Meeting prep: contact context + account brief + recent emails + action items.
   */
  async getMeetingPrep(contactName, accountName) {
    log.info(`Meeting prep: contact="${contactName}", account="${accountName}"`);

    const [contactCtx, accountBrief, actionItems] = await Promise.all([
      this.getContactContext(contactName),
      accountName ? this.getFullAccountBrief(accountName) : null,
      safe('fellow.actions', () =>
        this.fellow?.getActionItems({ status: 'open' }),
      ),
    ]);

    const prep = {
      contact:     contactCtx,
      account:     accountBrief,
      actionItems: actionItems || [],
    };

    this._emitAction('getMeetingPrep', 'multi', { contactName, accountName });
    return prep;
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------
const manager = new IntegrationManager();
export default manager;
