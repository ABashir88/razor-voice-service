#!/usr/bin/env node
// tests/voice-e2e.test.js
// End-to-end tests for the Razor voice pipeline fixes:
//   1. Speech fragmentation — _isCommandComplete + captureCommand prefix
//   2. Action dispatcher — get_context, check_calendar, etc.
//   3. PROCESSING timeout — 90s
//   4. Calendar integration — data-fetch-then-enrich flow
//
// These tests exercise real code paths without requiring live audio.
// The calendar + brain tests require brain server running at localhost:8780.

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
// Seed env vars
// ---------------------------------------------------------------------------
process.env.GOG_ACCOUNT = 'alrazi@telnyx.com';
process.env.SALESLOFT_API_KEY = 'test-sl-key';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function run() {
  // =========================================================================
  // 1. SPEECH FRAGMENTATION — _isCommandComplete logic
  // =========================================================================
  section('Speech: _isCommandComplete');

  const { VoicePipeline } = await import(
    resolve(__dirname, '..', 'src', 'pipeline', 'voice-pipeline.js')
  );

  // Create pipeline just for testing the method — don't call init()
  const pipeline = new VoicePipeline();

  // Too short — less than 4 words
  assert(!pipeline._isCommandComplete('what is'), 'Rejects 2-word fragment "what is"');
  assert(!pipeline._isCommandComplete('check my'), 'Rejects 2-word fragment "check my"');
  assert(!pipeline._isCommandComplete('hi'), 'Rejects 1-word');
  assert(!pipeline._isCommandComplete(''), 'Rejects empty string');
  assert(!pipeline._isCommandComplete(null), 'Rejects null');

  // 3 words — still too short
  assert(!pipeline._isCommandComplete('what is on'), 'Rejects 3-word fragment');

  // 4+ words WITH punctuation — complete
  assert(pipeline._isCommandComplete('what is on my calendar?'), 'Accepts 5 words with ?');
  assert(pipeline._isCommandComplete('send an email to John.'), 'Accepts 5 words with .');
  assert(pipeline._isCommandComplete('check my calendar for tomorrow!'), 'Accepts 5 words with !');

  // 4+ words WITHOUT punctuation — not complete (needs 8+)
  assert(!pipeline._isCommandComplete('what is on my calendar'), 'Rejects 5 words no punctuation');
  assert(!pipeline._isCommandComplete('send email to John Smith'), 'Rejects 5 words no punctuation');

  // 8+ words — complete even without punctuation
  assert(pipeline._isCommandComplete('what is on my calendar for tomorrow morning please'),
    'Accepts 8 words without punctuation');
  assert(pipeline._isCommandComplete('tell me about the meeting with John next week'),
    'Accepts 9 words without punctuation');

  // Real test case from the bug report
  assert(!pipeline._isCommandComplete('what is'),
    'Bug case: "what is" alone is rejected (was being sent to brain)');
  assert(pipeline._isCommandComplete('what is on my calendar for tomorrow?'),
    'Bug case: full sentence is accepted');

  // =========================================================================
  // 2. PROCESSING TIMEOUT — verify it's 90s, not 8s
  // =========================================================================
  section('State: PROCESSING timeout');

  const { StateTimeouts, States } = await import(
    resolve(__dirname, '..', 'src', 'state', 'stateConfig.js')
  );

  assert(StateTimeouts[States.PROCESSING] === 90_000,
    `PROCESSING timeout is 90s (got ${StateTimeouts[States.PROCESSING]}ms)`);
  assert(StateTimeouts[States.PROCESSING] > 60_000,
    'PROCESSING timeout exceeds brain response timeout (60s)');

  // =========================================================================
  // 3. VAD + DEEPGRAM — silence thresholds
  // =========================================================================
  section('Config: VAD + Deepgram settings');

  const config = (await import(resolve(__dirname, '..', 'src', 'config.js'))).default;

  assert(config.vad.silenceDurationMs === 3000,
    `VAD silence is 3000ms (got ${config.vad.silenceDurationMs})`);

  // =========================================================================
  // 4. ACTION DISPATCHER — get_context routing
  // =========================================================================
  section('Dispatcher: get_context routing');

  // We can't import dispatchAction directly (it's module-scoped in index.js),
  // but we can verify the integration manager handles all the routes.

  const { IntegrationManager } = await import(
    resolve(__dirname, '..', 'src', 'integrations', 'index.js')
  );

  const mgr = new IntegrationManager();

  // Test that getUpcomingSchedule and getContactContext exist and are callable
  assert(typeof mgr.getUpcomingSchedule === 'function', 'getUpcomingSchedule exists');
  assert(typeof mgr.getContactContext === 'function', 'getContactContext exists');
  assert(typeof mgr.getFullAccountBrief === 'function', 'getFullAccountBrief exists');

  // Graceful degradation — no services configured, should return data not throw
  const schedule = await mgr.getUpcomingSchedule(1);
  assert(Array.isArray(schedule.calendarEvents), 'getUpcomingSchedule returns calendarEvents array');

  const contactCtx = await mgr.getContactContext('test');
  assert(Array.isArray(contactCtx.salesforce), 'getContactContext returns salesforce array');

  // =========================================================================
  // 5. BRAIN + CALENDAR E2E — requires brain server at localhost:8780
  // =========================================================================
  section('E2E: Brain + Calendar integration');

  let brainAvailable = false;
  try {
    const healthRes = await fetch('http://127.0.0.1:8780/health', { signal: AbortSignal.timeout(3000) });
    brainAvailable = healthRes.ok;
  } catch {
    brainAvailable = false;
  }

  if (!brainAvailable) {
    console.log('  ⚠️  Brain server not running — skipping live E2E tests');
    console.log('     Start with: cd brain && python3 -m razor_brain.server');
  } else {
    console.log('  Brain server detected — running live tests');

    // Test 5a: Brain returns a calendar action for calendar queries
    const brainRes = await fetch('http://127.0.0.1:8780/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'What is on my calendar for tomorrow?' }),
      signal: AbortSignal.timeout(30000),
    });
    const brainData = await brainRes.json();

    assert(brainData.actions?.length > 0, 'Brain suggests action(s) for calendar query');

    const calAction = brainData.actions.find(a =>
      ['get_context', 'check_calendar', 'get_calendar', 'get_schedule'].includes(a.action)
    );
    assert(calAction != null, `Brain suggests calendar action (got: ${calAction?.action || 'none'})`);

    // Test 5b: Verify the calendar action type is in our dispatcher
    const handledActions = [
      'search_contact', 'lookup_contact', 'get_context',
      'log_call', 'log_interaction',
      'send_email', 'send_follow_up', 'draft_email',
      'research', 'search_web',
      'get_schedule', 'get_calendar', 'check_calendar',
      'account_brief', 'lookup_account',
      'meeting_prep',
      'schedule_meeting', 'create_event',
      'create_task',
      'update_opportunity', 'update_crm',
    ];
    if (calAction) {
      assert(handledActions.includes(calAction.action),
        `Action "${calAction.action}" is handled by dispatcher`);
    }

    // Test 5c: Google Calendar returns real data
    const { createGoogleClient } = await import(
      resolve(__dirname, '..', 'src', 'integrations', 'google.js')
    );
    const google = createGoogleClient();
    if (google) {
      try {
        const events = await google.getUpcomingEvents(2);
        assert(Array.isArray(events), 'Google returns events array');
        assert(events.length > 0, `Google returned ${events.length} event(s)`);
        assert(events[0].summary != null, 'Events have summary field');
        console.log(`     (Sample: "${events[0].summary}" at ${events[0].start})`);
      } catch (err) {
        assert(false, `Google Calendar fetch failed: ${err.message}`);
      }
    } else {
      console.log('  ⚠️  Google client not configured — skipping calendar fetch test');
    }

    // Test 5d: Brain enrichment — send data back and get natural response
    if (google) {
      try {
        const events = await google.getUpcomingEvents(1);
        const dataContext = `[check_calendar]: ${JSON.stringify({
          calendarEvents: events.slice(0, 3),
        })}`;

        const enrichedRes = await fetch('http://127.0.0.1:8780/process', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: `[INTEGRATION DATA]\n${dataContext}\n\nUser's original question: "What is on my calendar for tomorrow?"\n\nUsing the data above, give a natural spoken answer to the user's question. Be concise.`,
          }),
          signal: AbortSignal.timeout(30000),
        });
        const enrichedData = await enrichedRes.json();
        const enrichedText = enrichedData.text || '';

        assert(enrichedText.length > 20, `Brain returned enriched response (${enrichedText.length} chars)`);
        // The response should mention something about the calendar
        const mentionsCalendar = /calendar|schedule|meeting|event|tomorrow|today/i.test(enrichedText);
        assert(mentionsCalendar, 'Enriched response references calendar/schedule');
        console.log(`     Response: "${enrichedText.slice(0, 120)}${enrichedText.length > 120 ? '...' : ''}"`);
      } catch (err) {
        assert(false, `Brain enrichment failed: ${err.message}`);
      }
    }

    // Test 5e: Multiple calendar query phrasings
    const phrasings = [
      'Check my calendar for this week',
      'Do I have any meetings today',
      "What's on my schedule",
    ];

    for (const phrase of phrasings) {
      try {
        const res = await fetch('http://127.0.0.1:8780/process', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: phrase }),
          signal: AbortSignal.timeout(30000),
        });
        const data = await res.json();
        const hasCalAction = data.actions?.some(a =>
          ['get_context', 'check_calendar', 'get_calendar', 'get_schedule'].includes(a.action)
        );
        assert(hasCalAction, `"${phrase}" → brain suggests calendar action`);
      } catch (err) {
        assert(false, `"${phrase}" failed: ${err.message}`);
      }
    }
  }

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
