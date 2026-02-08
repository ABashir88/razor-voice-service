// src/integrations/salesforce.js
// Salesforce client for Razor — uses sf CLI (authenticated via Okta SSO).
//
// All queries shell out to the Salesforce CLI (`sf`), which is already
// authenticated against the org alias specified by SF_ORG_ALIAS in .env.
// This avoids the username/password flow that breaks with Okta SSO.

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import makeLogger from '../utils/logger.js';
import { integrationConfig } from './config.js';

const execFile = promisify(execFileCb);
const log = makeLogger('Salesforce');

// Max buffer for sf CLI output (5 MB — account records can be large)
const MAX_BUFFER = 5 * 1024 * 1024;
// Per-command timeout (30 s)
const CMD_TIMEOUT = 30_000;
// Retry settings for transient CLI failures
const MAX_RETRIES = 3;
const BASE_DELAY  = 500;

// ---------------------------------------------------------------------------
// Opportunity fields — standard fields only (no custom MEDDPICC)
// ---------------------------------------------------------------------------
const OPP_FIELDS = [
  'Id', 'Name', 'AccountId', 'StageName', 'Amount', 'Probability',
  'CloseDate', 'Type', 'NextStep', 'LeadSource', 'IsClosed', 'IsWon',
  'ForecastCategory', 'OwnerId', 'CreatedDate', 'LastModifiedDate',
].join(', ');

// ---------------------------------------------------------------------------
// User filter — scope queries to this AE's records
// ---------------------------------------------------------------------------
const OWNER_ID = '005Qk000005ZqldIAC';
const OWNER_FILTER = `OwnerId = '${OWNER_ID}'`;

// ---------------------------------------------------------------------------
// SalesforceClient — sf CLI wrapper
// ---------------------------------------------------------------------------
export class SalesforceClient {
  constructor(orgAlias) {
    this.orgAlias = orgAlias;
    this._ready = false;
  }

  // ---- Internal: run sf CLI command and parse JSON output ------------------

  /**
   * Execute an sf CLI command with --json output and retry on transient errors.
   * Returns the parsed `result` property from the JSON envelope.
   */
  async _sf(args, label = 'sf') {
    const fullArgs = [...args, '--target-org', this.orgAlias, '--json'];
    log.debug(`${label}: sf ${fullArgs.join(' ')}`);

    let attempt = 0;
    while (true) {
      try {
        const { stdout } = await execFile('sf', fullArgs, {
          maxBuffer: MAX_BUFFER,
          timeout: CMD_TIMEOUT,
        });
        const parsed = JSON.parse(stdout);

        if (parsed.status !== 0) {
          const msg = parsed.message || parsed.name || `exit status ${parsed.status}`;
          throw new Error(msg);
        }

        return parsed.result;
      } catch (err) {
        attempt += 1;
        const isTransient = err.killed || err.signal
          || /timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up/i.test(err.message);

        if (isTransient && attempt < MAX_RETRIES) {
          const delay = BASE_DELAY * 2 ** (attempt - 1);
          log.warn(`${label} transient error, retry ${attempt}/${MAX_RETRIES} in ${delay}ms`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        // If sf returned JSON with an error message, surface it
        if (err.stdout) {
          try {
            const parsed = JSON.parse(err.stdout);
            const msg = parsed.message || parsed.name || err.message;
            log.error(`${label} failed: ${msg}`);
            throw new Error(msg);
          } catch { /* not JSON, fall through */ }
        }
        log.error(`${label} failed (attempt ${attempt}): ${err.message}`);
        throw err;
      }
    }
  }

  // ---- Auth (validate sf CLI connectivity) --------------------------------

  /**
   * Validate that sf CLI can reach the org.
   * Called by IntegrationManager.initialize() — keeps same interface.
   */
  async login() {
    log.info(`Validating sf CLI connectivity (org: ${this.orgAlias})`);
    try {
      const result = await this._sf(
        ['data', 'query', '--query', 'SELECT Id FROM Account LIMIT 1'],
        'login-check',
      );
      this._ready = true;
      log.info(`Connected via sf CLI — org validated (${result?.totalSize ?? '?'} record(s))`);
      return this;
    } catch (err) {
      log.error(`sf CLI validation failed: ${err.message}`);
      throw err;
    }
  }

  // ---- SOQL ---------------------------------------------------------------

  /**
   * Run an arbitrary SOQL query.
   * @param {string} soql - The SOQL query string.
   * @returns {Array} Array of record objects.
   */
  async query(soql) {
    const result = await this._sf(
      ['data', 'query', '--query', soql],
      'query',
    );
    return result?.records ?? [];
  }

  // ---- Contacts -----------------------------------------------------------

  async getContact(id) {
    const result = await this._sf(
      ['data', 'get', 'record', '--sobject', 'Contact', '--record-id', id],
      'getContact',
    );
    return result;
  }

  async searchContacts(name) {
    const escaped = name.replace(/'/g, "\\'");
    const soql = `SELECT Id, FirstName, LastName, Email, Phone, Title, AccountId, Account.Name FROM Contact WHERE Name LIKE '%${escaped}%' ORDER BY LastModifiedDate DESC LIMIT 20`;
    return this.query(soql);
  }

  // ---- Accounts -----------------------------------------------------------

  async getAccount(id) {
    const result = await this._sf(
      ['data', 'get', 'record', '--sobject', 'Account', '--record-id', id],
      'getAccount',
    );
    return result;
  }

  async searchAccounts(name) {
    const escaped = name.replace(/'/g, "\\'");
    const soql = `SELECT Id, Name, Industry, Website, AnnualRevenue, NumberOfEmployees, Description FROM Account WHERE Name LIKE '%${escaped}%' ORDER BY LastModifiedDate DESC LIMIT 20`;
    return this.query(soql);
  }

  // ---- Opportunities ------------------------------------------------------

  async getOpportunity(id) {
    const soql = `SELECT ${OPP_FIELDS} FROM Opportunity WHERE Id = '${id}' AND ${OWNER_FILTER} LIMIT 1`;
    const records = await this.query(soql);
    return records[0] ?? null;
  }

  async getOpportunitiesByAccount(accountId) {
    const soql = `SELECT ${OPP_FIELDS} FROM Opportunity WHERE AccountId = '${accountId}' AND ${OWNER_FILTER} ORDER BY CloseDate ASC`;
    return this.query(soql);
  }

  async queryOpportunities(params = {}) {
    const stage = params.stage ? `AND StageName = '${params.stage.replace(/'/g, "\\'")}'` : '';
    const closedFilter = params.includeClosed ? '' : 'AND IsClosed = false';
    const soql = `SELECT ${OPP_FIELDS} FROM Opportunity WHERE ${OWNER_FILTER} ${closedFilter} ${stage} ORDER BY CloseDate ASC LIMIT 50`;
    return this.query(soql);
  }

  async getPipeline() {
    try {
      const totalResult = await this.query(
        `SELECT SUM(Amount) FROM Opportunity WHERE OwnerId = '${OWNER_ID}' AND IsClosed = false`,
      );
      const total = totalResult[0]?.expr0 || 0;

      const countResult = await this.query(
        `SELECT COUNT(Id) FROM Opportunity WHERE OwnerId = '${OWNER_ID}' AND IsClosed = false`,
      );
      const count = countResult[0]?.expr0 || 0;

      return {
        total,
        count,
        text: `${count} open deals, $${Math.round(total / 1000)}k total pipeline.`,
      };
    } catch (error) {
      log.error('[Salesforce] getPipeline error:', error.message);
      throw error;
    }
  }

  async getDealsClosing(period = 'this_week') {
    try {
      const today = new Date().toISOString().split('T')[0];
      const days = period === 'this_month' ? 30 : 7;
      const endDate = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

      return await this.query(
        `SELECT Name, Amount, StageName, CloseDate FROM Opportunity WHERE OwnerId = '${OWNER_ID}' AND IsClosed = false AND CloseDate >= ${today} AND CloseDate <= ${endDate} ORDER BY CloseDate ASC LIMIT 10`,
      );
    } catch (error) {
      log.error('[Salesforce] getDealsClosing error:', error.message);
      throw error;
    }
  }

  async getBiggestDeal() {
    try {
      return await this.query(
        `SELECT Name, Amount, StageName, CloseDate FROM Opportunity WHERE OwnerId = '${OWNER_ID}' AND IsClosed = false AND Amount != null ORDER BY Amount DESC LIMIT 1`,
      );
    } catch (error) {
      log.error('[Salesforce] getBiggestDeal error:', error.message);
      throw error;
    }
  }

  async getStaleDeals(days = 7) {
    try {
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      return await this.query(
        `SELECT Name, Amount, StageName, LastModifiedDate FROM Opportunity WHERE OwnerId = '${OWNER_ID}' AND IsClosed = false AND LastModifiedDate < ${cutoff} ORDER BY LastModifiedDate ASC LIMIT 5`,
      );
    } catch (error) {
      log.error('[Salesforce] getStaleDeals error:', error.message);
      throw error;
    }
  }

  async getTasks() {
    try {
      const today = new Date().toISOString().split('T')[0];
      return await this.query(
        `SELECT Subject, Status, ActivityDate FROM Task WHERE OwnerId = '${OWNER_ID}' AND IsClosed = false AND ActivityDate <= ${today} ORDER BY ActivityDate ASC LIMIT 10`,
      );
    } catch (error) {
      log.error('[Salesforce] getTasks error:', error.message);
      throw error;
    }
  }

  async getDecisionMaker(accountName) {
    try {
      const escaped = accountName.replace(/'/g, "\\'");
      return await this.query(
        `SELECT Name, Title, Phone, Email FROM Contact WHERE Account.Name LIKE '%${escaped}%' AND (Title LIKE '%VP%' OR Title LIKE '%Director%' OR Title LIKE '%Chief%' OR Title LIKE '%Head%' OR Title LIKE '%President%') LIMIT 3`,
      );
    } catch (error) {
      log.error('[Salesforce] getDecisionMaker error:', error.message);
      throw error;
    }
  }

  /**
   * Find a deal (Opportunity) by name or account name.
   * @param {string} name - Deal or account name to search for.
   * @returns {object|null} Formatted deal object or null if not found.
   */
  async getDealByName(name) {
    try {
      const escaped = name.replace(/'/g, "\\'");
      const soql = `SELECT Id, Name, Amount, StageName, LastActivityDate, CloseDate, Account.Name, Owner.Name FROM Opportunity WHERE (Name LIKE '%${escaped}%' OR Account.Name LIKE '%${escaped}%') AND ${OWNER_FILTER} ORDER BY Amount DESC NULLS LAST LIMIT 1`;
      const records = await this.query(soql);

      if (!records || records.length === 0) return null;

      const deal = records[0];
      return {
        id:           deal.Id,
        name:         deal.Name,
        amount:       deal.Amount ? `${(deal.Amount / 1000).toFixed(0)}k` : null,
        stage:        deal.StageName,
        closeDate:    deal.CloseDate,
        lastActivity: deal.LastActivityDate,
        account:      deal.Account?.Name,
        owner:        deal.Owner?.Name,
      };
    } catch (err) {
      log.error('[Salesforce] getDealByName error:', err.message);
      return null;
    }
  }

  /**
   * Get deals closing within the next N days.
   * @param {number} [days=7]
   * @returns {Array} Formatted deal objects with account names.
   */
  async getDealsClosingSoon(days = 7) {
    try {
      const today = new Date().toISOString().split('T')[0];
      const future = new Date(Date.now() + days * 86_400_000).toISOString().split('T')[0];
      const soql = `SELECT Id, Name, Amount, StageName, CloseDate, Account.Name FROM Opportunity WHERE ${OWNER_FILTER} AND IsClosed = false AND CloseDate >= ${today} AND CloseDate <= ${future} ORDER BY CloseDate ASC LIMIT 10`;
      const records = await this.query(soql);

      return records.map((d) => ({
        name:      d.Name,
        amount:    d.Amount ? `${(d.Amount / 1000).toFixed(0)}k` : 'no amount',
        closeDate: d.CloseDate,
        stage:     d.StageName,
        account:   d.Account?.Name,
      }));
    } catch (err) {
      log.error('[Salesforce] getDealsClosingSoon error:', err.message);
      return [];
    }
  }

  async updateOpportunity(id, fields) {
    const values = Object.entries(fields)
      .map(([k, v]) => `${k}='${String(v).replace(/'/g, "\\'")}'`)
      .join(' ');
    return this._sf(
      ['data', 'update', 'record', '--sobject', 'Opportunity', '--record-id', id, '--values', values],
      'updateOpportunity',
    );
  }

  // ---- Tasks & Activities -------------------------------------------------

  async createTask(data) {
    const fields = {
      Subject: data.subject || 'Follow Up',
      Status: data.status || 'Not Started',
      Priority: data.priority || 'Normal',
      ActivityDate: data.dueDate || new Date().toISOString().slice(0, 10),
    };
    if (data.whoId) fields.WhoId = data.whoId;
    if (data.whatId) fields.WhatId = data.whatId;
    if (data.ownerId) fields.OwnerId = data.ownerId;
    if (data.description) fields.Description = data.description;

    const values = Object.entries(fields)
      .map(([k, v]) => `${k}='${String(v).replace(/'/g, "\\'")}'`)
      .join(' ');
    return this._sf(
      ['data', 'create', 'record', '--sobject', 'Task', '--values', values],
      'createTask',
    );
  }

  async getUpcomingTasks(days = 7) {
    const until = new Date();
    until.setDate(until.getDate() + days);
    const soql = `SELECT Id, Subject, Status, Priority, ActivityDate, WhoId, WhatId, Description FROM Task WHERE OwnerId = '${OWNER_ID}' AND ActivityDate <= ${until.toISOString().slice(0, 10)} AND IsClosed = false ORDER BY ActivityDate ASC`;
    return this.query(soql);
  }

  async logActivity(whoId, whatId, data = {}) {
    const fields = {
      Subject: data.subject || 'Call',
      Status: 'Completed',
      TaskSubtype: data.subtype || 'Call',
      ActivityDate: new Date().toISOString().slice(0, 10),
    };
    if (whoId) fields.WhoId = whoId;
    if (whatId) fields.WhatId = whatId;
    if (data.description) fields.Description = data.description;
    if (data.duration) fields.CallDurationInSeconds = data.duration;
    if (data.disposition) fields.CallDisposition = data.disposition;

    const values = Object.entries(fields)
      .map(([k, v]) => `${k}='${String(v).replace(/'/g, "\\'")}'`)
      .join(' ');
    return this._sf(
      ['data', 'create', 'record', '--sobject', 'Task', '--values', values],
      'logActivity',
    );
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
let _instance = null;

export function createSalesforceClient() {
  if (_instance) return _instance;
  const c = integrationConfig.salesforce;

  // Prefer sf CLI path
  if (c?.orgAlias) {
    log.info(`Using sf CLI with org alias: ${c.orgAlias}`);
    _instance = new SalesforceClient(c.orgAlias);
    return _instance;
  }

  // Legacy paths not supported after migration to sf CLI
  log.info('Salesforce: SF_ORG_ALIAS not set — client disabled');
  return null;
}

export default SalesforceClient;
