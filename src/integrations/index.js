// src/integrations/index.js
// Integration Manager — unified coordinator for all Razor integrations.

import EventEmitter from 'eventemitter3';
import makeLogger from '../utils/logger.js';
import { getEnabledIntegrations } from './config.js';
import { createSalesloftClient } from './salesloft.js';
import { createSalesforceClient } from './salesforce.js';
import { createGoogleClient } from './google.js';
import { createFellowClient } from './fellow.js';
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
        return this.fellow?.getMeetings({ from, to });
      }),
    ]);

    return {
      calendarEvents:  events   || [],
      salesforceTasks: tasks    || [],
      fellowMeetings:  meetings || [],
    };
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
   * Full account brief: Salesforce account + opportunities + Salesloft activities + web research.
   */
  async getFullAccountBrief(accountName) {
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

    this._emitAction('getFullAccountBrief', 'multi', { accountName });
    return brief;
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
