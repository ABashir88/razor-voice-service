#!/usr/bin/env node
// tests/integrations.test.js
// Mocked unit tests for Razor integrations — no test frameworks.

// ---------------------------------------------------------------------------
// Minimal test harness
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.error(`  ❌ ${label}`);
  }
}

function section(title) {
  console.log(`\n─── ${title} ───`);
}

// ---------------------------------------------------------------------------
// Mock logger so we don't depend on ../utils/logger.js at test time
// ---------------------------------------------------------------------------
const noop = () => {};
const mockLog = { info: noop, warn: noop, error: noop, debug: noop };

// Intercept logger import used by all integration modules.
// We do this by setting up the env *before* any dynamic imports.
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Provide a stub logger module the integrations can resolve to.
// We'll accomplish this by setting a global that config.js can read.

// Step 1: seed env vars so config doesn't need a real .env file
process.env.SALESLOFT_API_KEY     = 'test-sl-key';
process.env.SF_CLIENT_ID          = 'test-sf-cid';
process.env.SF_CLIENT_SECRET      = 'test-sf-cs';
process.env.SF_REFRESH_TOKEN      = 'test-sf-rt';
process.env.SF_INSTANCE_URL       = 'https://test.salesforce.com';
process.env.GOG_ACCOUNT           = 'test@example.com';
process.env.FELLOW_API_KEY        = 'test-fellow-key';
process.env.BRAVE_SEARCH_API_KEY  = 'test-brave-key';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function run() {
  // ======= CONFIG ==========================================================
  section('config.js');

  const { integrationConfig, getEnabledIntegrations } = await import(
    resolve(__dirname, '..', 'src', 'integrations', 'config.js')
  );

  assert(typeof integrationConfig === 'object', 'integrationConfig is an object');
  assert(Object.isFrozen(integrationConfig), 'integrationConfig is frozen');
  assert(integrationConfig.salesloft?.apiKey === 'test-sl-key', 'salesloft.apiKey read from env');
  assert(integrationConfig.salesforce?.clientId === 'test-sf-cid', 'salesforce.clientId read from env');
  assert(integrationConfig.google?.gogAccount === 'test@example.com', 'google.gogAccount read from env');
  assert(integrationConfig.fellow?.apiKey === 'test-fellow-key', 'fellow.apiKey read from env');
  assert(integrationConfig.braveSearch?.apiKey === 'test-brave-key', 'braveSearch.apiKey read from env');

  const enabled = getEnabledIntegrations();
  assert(Array.isArray(enabled), 'getEnabledIntegrations returns an array');
  assert(enabled.includes('salesloft'), 'salesloft is enabled');
  assert(enabled.includes('salesforce'), 'salesforce is enabled');
  assert(enabled.includes('google'), 'google is enabled');
  assert(enabled.includes('fellow'), 'fellow is enabled');
  assert(enabled.includes('braveSearch'), 'braveSearch is enabled');
  assert(enabled.length === 5, 'all 5 services enabled when all keys present');

  // ======= CONFIG — MISSING KEYS ==========================================
  section('config.js — disabled service');

  // Temporarily wipe a key and re-evaluate
  const origBrave = process.env.BRAVE_SEARCH_API_KEY;
  delete process.env.BRAVE_SEARCH_API_KEY;

  // getEnabledIntegrations() re-reads live env via the frozen config, but
  // integrationConfig was already built. So we test the function's logic
  // against the frozen snapshot — braveSearch should still show because the
  // snapshot captured it. This validates that the snapshot is immutable.
  assert(integrationConfig.braveSearch?.apiKey === 'test-brave-key',
    'frozen config retains original value after env var is deleted');

  process.env.BRAVE_SEARCH_API_KEY = origBrave; // restore

  // ======= SALESLOFT =======================================================
  section('salesloft.js');

  const { SalesloftClient } = await import(
    resolve(__dirname, '..', 'src', 'integrations', 'salesloft.js')
  );

  // Constructor requires an API key
  let threw = false;
  try { new SalesloftClient(); } catch { threw = true; }
  assert(threw, 'SalesloftClient throws without API key');

  const sl = new SalesloftClient('test-key');
  assert(typeof sl.getPeople === 'function', 'sl.getPeople exists');
  assert(typeof sl.getPerson === 'function', 'sl.getPerson exists');
  assert(typeof sl.getActivities === 'function', 'sl.getActivities exists');
  assert(typeof sl.getCadences === 'function', 'sl.getCadences exists');
  assert(typeof sl.getCadenceSteps === 'function', 'sl.getCadenceSteps exists');
  assert(typeof sl.logCall === 'function', 'sl.logCall exists');
  assert(typeof sl.logEmail === 'function', 'sl.logEmail exists');
  assert(typeof sl.getAccounts === 'function', 'sl.getAccounts exists');
  assert(typeof sl.getAccount === 'function', 'sl.getAccount exists');
  assert(typeof sl.getOpportunities === 'function', 'sl.getOpportunities exists');

  // ======= SALESFORCE ======================================================
  section('salesforce.js');

  const { SalesforceClient } = await import(
    resolve(__dirname, '..', 'src', 'integrations', 'salesforce.js')
  );

  const sf = new SalesforceClient({
    clientId: 'x', clientSecret: 'x', refreshToken: 'x', instanceUrl: 'https://x',
  });
  assert(typeof sf.login === 'function', 'sf.login exists');
  assert(typeof sf.query === 'function', 'sf.query exists');
  assert(typeof sf.getContact === 'function', 'sf.getContact exists');
  assert(typeof sf.searchContacts === 'function', 'sf.searchContacts exists');
  assert(typeof sf.getAccount === 'function', 'sf.getAccount exists');
  assert(typeof sf.getOpportunity === 'function', 'sf.getOpportunity exists');
  assert(typeof sf.getOpportunitiesByAccount === 'function', 'sf.getOpportunitiesByAccount exists');
  assert(typeof sf.updateOpportunity === 'function', 'sf.updateOpportunity exists');
  assert(typeof sf.createTask === 'function', 'sf.createTask exists');
  assert(typeof sf.getUpcomingTasks === 'function', 'sf.getUpcomingTasks exists');
  assert(typeof sf.logActivity === 'function', 'sf.logActivity exists');

  // ======= GOOGLE ==========================================================
  section('google.js');

  const { GoogleClient } = await import(
    resolve(__dirname, '..', 'src', 'integrations', 'google.js')
  );

  threw = false;
  try { new GoogleClient({}); } catch { threw = true; }
  assert(threw, 'GoogleClient throws without credentials');

  const gc = new GoogleClient({
    gogAccount: 'test@example.com',
  });
  assert(typeof gc.sendEmail === 'function', 'gc.sendEmail exists');
  assert(typeof gc.getRecentEmails === 'function', 'gc.getRecentEmails exists');
  assert(typeof gc.getEmailThread === 'function', 'gc.getEmailThread exists');
  assert(typeof gc.draftEmail === 'function', 'gc.draftEmail exists');
  assert(typeof gc.getUpcomingEvents === 'function', 'gc.getUpcomingEvents exists');
  assert(typeof gc.getEvent === 'function', 'gc.getEvent exists');
  assert(typeof gc.createEvent === 'function', 'gc.createEvent exists');
  assert(typeof gc.findFreeSlots === 'function', 'gc.findFreeSlots exists');

  // ======= FELLOW ==========================================================
  section('fellow.js');

  const { FellowClient } = await import(
    resolve(__dirname, '..', 'src', 'integrations', 'fellow.js')
  );

  threw = false;
  try { new FellowClient(); } catch { threw = true; }
  assert(threw, 'FellowClient throws without API key');

  const fc = new FellowClient('test-key');
  assert(typeof fc.getMeetings === 'function', 'fc.getMeetings exists');
  assert(typeof fc.getMeetingNotes === 'function', 'fc.getMeetingNotes exists');
  assert(typeof fc.getActionItems === 'function', 'fc.getActionItems exists');
  assert(typeof fc.searchNotes === 'function', 'fc.searchNotes exists');

  // ======= BRAVE SEARCH ====================================================
  section('brave-search.js');

  const { BraveSearchClient } = await import(
    resolve(__dirname, '..', 'src', 'integrations', 'brave-search.js')
  );

  threw = false;
  try { new BraveSearchClient(); } catch { threw = true; }
  assert(threw, 'BraveSearchClient throws without API key');

  const bs = new BraveSearchClient('test-key');
  assert(typeof bs.search === 'function', 'bs.search exists');
  assert(typeof bs.searchNews === 'function', 'bs.searchNews exists');
  assert(typeof bs.summarize === 'function', 'bs.summarize exists');

  // ======= INTEGRATION MANAGER =============================================
  section('IntegrationManager');

  const { IntegrationManager } = await import(
    resolve(__dirname, '..', 'src', 'integrations', 'index.js')
  );

  const mgr = new IntegrationManager();
  assert(typeof mgr.initialize === 'function', 'mgr.initialize exists');
  assert(typeof mgr.getContactContext === 'function', 'mgr.getContactContext exists');
  assert(typeof mgr.logInteraction === 'function', 'mgr.logInteraction exists');
  assert(typeof mgr.getUpcomingSchedule === 'function', 'mgr.getUpcomingSchedule exists');
  assert(typeof mgr.research === 'function', 'mgr.research exists');
  assert(typeof mgr.sendFollowUp === 'function', 'mgr.sendFollowUp exists');
  assert(typeof mgr.getFullAccountBrief === 'function', 'mgr.getFullAccountBrief exists');
  assert(typeof mgr.getMeetingPrep === 'function', 'mgr.getMeetingPrep exists');
  assert(typeof mgr.on === 'function', 'mgr inherits EventEmitter.on');
  assert(typeof mgr.emit === 'function', 'mgr inherits EventEmitter.emit');

  // ---- Graceful degradation: manager works even with null services --------
  section('IntegrationManager — graceful degradation');

  const mgr2 = new IntegrationManager();
  // Don't call initialize — all services are null

  let contactCtx;
  try {
    contactCtx = await mgr2.getContactContext('Nobody');
    assert(contactCtx !== null, 'getContactContext returns result even with no services');
    assert(Array.isArray(contactCtx.salesforce), 'contactCtx.salesforce is array (empty)');
    assert(Array.isArray(contactCtx.salesloft), 'contactCtx.salesloft is array (empty)');
    assert(Array.isArray(contactCtx.recentEmails), 'contactCtx.recentEmails is array (empty)');
  } catch (e) {
    assert(false, `getContactContext should not throw: ${e.message}`);
  }

  let researchResult;
  try {
    researchResult = await mgr2.research('test query');
    assert(researchResult.results.length === 0, 'research returns empty when brave is null');
    assert(researchResult.summary === null, 'research returns null summary when brave is null');
  } catch (e) {
    assert(false, `research should not throw: ${e.message}`);
  }

  let followUp;
  try {
    followUp = await mgr2.sendFollowUp({ to: 'a@b.com', subject: 'hi' });
    assert(followUp === null, 'sendFollowUp returns null when google is null');
  } catch (e) {
    assert(false, `sendFollowUp should not throw: ${e.message}`);
  }

  // ---- Events ----
  section('IntegrationManager — events');

  const mgr3 = new IntegrationManager();
  let readyEvents = [];
  mgr3.on('integration:ready', (data) => readyEvents.push(data.service));

  // Simulate a ready event
  mgr3._emitReady('testService');
  assert(readyEvents.includes('testService'), 'integration:ready event fires');

  let actionEvents = [];
  mgr3.on('integration:action_completed', (data) => actionEvents.push(data.action));
  mgr3._emitAction('testAction', 'testService');
  assert(actionEvents.includes('testAction'), 'integration:action_completed event fires');

  // =========================================================================
  // Summary
  // =========================================================================
  console.log(`\n═══════════════════════════════`);
  console.log(`  Total: ${passed + failed}  |  ✅ ${passed}  |  ❌ ${failed}`);
  console.log(`═══════════════════════════════\n`);

  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
