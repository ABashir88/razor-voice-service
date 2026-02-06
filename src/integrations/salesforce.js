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

// ---------------------------------------------------------------------------
// MEDDPICC custom fields — pulled into every Opportunity query
// ---------------------------------------------------------------------------
const MEDDPICC_FIELDS = [
  'MEDDPICC_Score__c',
  'Champion__c',
  'Economic_Buyer__c',
  'Decision_Criteria__c',
  'Decision_Process__c',
  'Metrics__c',
  'Identify_Pain__c',
  'Paper_Process__c',
  'Competition__c',
];

const OPP_BASE_FIELDS = [
  'Id', 'Name', 'StageName', 'Amount', 'CloseDate', 'Probability',
  'AccountId', 'OwnerId', 'NextStep', 'Description', 'IsClosed', 'IsWon',
  'CreatedDate', 'LastModifiedDate',
];

const OPP_ALL_FIELDS = [...OPP_BASE_FIELDS, ...MEDDPICC_FIELDS].join(', ');

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
   * Execute an sf CLI command with --json output.
   * Returns the parsed `result` property from the JSON envelope.
   */
  async _sf(args, label = 'sf') {
    const fullArgs = [...args, '--target-org', this.orgAlias, '--json'];
    log.debug(`${label}: sf ${fullArgs.join(' ')}`);

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
      // If sf returned JSON with an error message, surface it
      if (err.stdout) {
        try {
          const parsed = JSON.parse(err.stdout);
          const msg = parsed.message || parsed.name || err.message;
          log.error(`${label} failed: ${msg}`);
          throw new Error(msg);
        } catch { /* not JSON, fall through */ }
      }
      log.error(`${label} failed: ${err.message}`);
      throw err;
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

  // ---- Opportunities (with MEDDPICC) --------------------------------------

  async getOpportunity(id) {
    const soql = `SELECT ${OPP_ALL_FIELDS} FROM Opportunity WHERE Id = '${id}' LIMIT 1`;
    const records = await this.query(soql);
    return records[0] ?? null;
  }

  async getOpportunitiesByAccount(accountId) {
    const soql = `SELECT ${OPP_ALL_FIELDS} FROM Opportunity WHERE AccountId = '${accountId}' ORDER BY CloseDate ASC`;
    return this.query(soql);
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

  async getUpcomingTasks(ownerId, days = 7) {
    const until = new Date();
    until.setDate(until.getDate() + days);
    const soql = `SELECT Id, Subject, Status, Priority, ActivityDate, WhoId, WhatId, Description FROM Task WHERE OwnerId = '${ownerId}' AND ActivityDate <= ${until.toISOString().slice(0, 10)} AND IsClosed = false ORDER BY ActivityDate ASC`;
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
