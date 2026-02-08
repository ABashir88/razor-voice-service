/**
 * userState.test.js — Tests for src/state/user-state.js
 * Run:  node tests/userState.test.js
 */

// UserState uses node:events internally (not eventemitter3), so we can
// import and test directly without mocking.

import { UserStates, USER_STATE_PATTERNS } from '../src/state/user-state.js';

// Fresh instance per test section — don't use the singleton
// (it may have persistent state from disk)
async function createFresh() {
  const { EventEmitter } = await import('events');
  const mod = await import('../src/state/user-state.js');

  // Create a raw instance bypassing singleton
  class TestUserState extends EventEmitter {
    constructor() {
      super();
      this.setMaxListeners(20);
      this._state = UserStates.AVAILABLE;
      this._enteredAt = Date.now();
      this._previousState = null;
      this._queuedAlerts = [];
      this._persistPath = null; // disable persistence in tests
    }
  }

  // Copy prototype methods from the real class
  const proto = Object.getPrototypeOf(mod.userState);
  for (const key of Object.getOwnPropertyNames(proto)) {
    if (key !== 'constructor') {
      Object.defineProperty(
        TestUserState.prototype,
        key,
        Object.getOwnPropertyDescriptor(proto, key),
      );
    }
  }

  return new TestUserState();
}

let passed = 0, failed = 0;

function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.log(`  ✗ ${label}`); failed++; }
}

function section(t) {
  console.log(`\n${'═'.repeat(60)}\n  ${t}\n${'═'.repeat(60)}`);
}

// ═══════════════════════════════════════════════════════════════
//  1. STATE DEFINITIONS
// ═══════════════════════════════════════════════════════════════

section('1. State Definitions');
{
  assert(UserStates.AVAILABLE === 'AVAILABLE', 'AVAILABLE defined');
  assert(UserStates.IN_CALL === 'IN_CALL', 'IN_CALL defined');
  assert(UserStates.FOCUSED === 'FOCUSED', 'FOCUSED defined');
  assert(UserStates.DND === 'DND', 'DND defined');
  assert(Object.keys(UserStates).length === 4, 'Exactly 4 states');
  assert(Object.isFrozen(UserStates), 'States are frozen');
}

// ═══════════════════════════════════════════════════════════════
//  2. INITIAL STATE
// ═══════════════════════════════════════════════════════════════

section('2. Initial State');
{
  const us = await createFresh();
  assert(us.state === UserStates.AVAILABLE, 'Starts in AVAILABLE');
  assert(us.canSpeak === true, 'canSpeak is true when AVAILABLE');
  assert(us.alertLevel === 'all', 'alertLevel is "all" when AVAILABLE');

  const status = us.getStatus();
  assert(status.state === 'AVAILABLE', 'getStatus() returns correct state');
  assert(status.queuedAlerts === 0, 'No queued alerts initially');
  assert(typeof status.elapsed === 'number', 'elapsed is a number');
}

// ═══════════════════════════════════════════════════════════════
//  3. TRANSITIONS
// ═══════════════════════════════════════════════════════════════

section('3. State Transitions');
{
  const us = await createFresh();

  // AVAILABLE → IN_CALL
  const r1 = us.transition(UserStates.IN_CALL, 'voice_command');
  assert(r1.ok === true, 'AVAILABLE → IN_CALL succeeds');
  assert(us.state === UserStates.IN_CALL, 'State is now IN_CALL');
  assert(us.canSpeak === false, 'canSpeak is false when IN_CALL');

  // IN_CALL → FOCUSED
  const r2 = us.transition(UserStates.FOCUSED, 'voice_command');
  assert(r2.ok === true, 'IN_CALL → FOCUSED succeeds');
  assert(us.state === UserStates.FOCUSED, 'State is now FOCUSED');

  // FOCUSED → DND
  const r3 = us.transition(UserStates.DND, 'voice_command');
  assert(r3.ok === true, 'FOCUSED → DND succeeds');
  assert(us.state === UserStates.DND, 'State is now DND');
  assert(us.canSpeak === false, 'canSpeak is false when DND');

  // DND → AVAILABLE
  const r4 = us.transition(UserStates.AVAILABLE, 'voice_command');
  assert(r4.ok === true, 'DND → AVAILABLE succeeds');
  assert(us.canSpeak === true, 'canSpeak is true again');
}

// ═══════════════════════════════════════════════════════════════
//  4. SAME-STATE TRANSITION (no-op)
// ═══════════════════════════════════════════════════════════════

section('4. Same-State Transition');
{
  const us = await createFresh();
  const r = us.transition(UserStates.AVAILABLE, 'test');
  assert(r.ok === true, 'Same-state transition returns ok');
  assert(r.already === true, 'Marked as already in state');
}

// ═══════════════════════════════════════════════════════════════
//  5. INVALID STATE
// ═══════════════════════════════════════════════════════════════

section('5. Invalid State');
{
  const us = await createFresh();
  const r = us.transition('INVALID_STATE', 'test');
  assert(r.ok === false, 'Invalid state returns error');
  assert(r.error.includes('Unknown'), 'Error message mentions unknown state');
  assert(us.state === UserStates.AVAILABLE, 'State unchanged after invalid transition');
}

// ═══════════════════════════════════════════════════════════════
//  6. BEHAVIOR FLAGS
// ═══════════════════════════════════════════════════════════════

section('6. Behavior Flags Per State');
{
  const us = await createFresh();

  // AVAILABLE
  assert(us.behavior.proactive === true, 'AVAILABLE: proactive=true');
  assert(us.behavior.alertLevel === 'all', 'AVAILABLE: alertLevel=all');

  // IN_CALL
  us.transition(UserStates.IN_CALL, 'test');
  assert(us.behavior.proactive === false, 'IN_CALL: proactive=false');
  assert(us.behavior.alertLevel === 'none', 'IN_CALL: alertLevel=none');
  assert(us.behavior.queue === true, 'IN_CALL: queue=true');

  // FOCUSED
  us.transition(UserStates.FOCUSED, 'test');
  assert(us.behavior.proactive === false, 'FOCUSED: proactive=false');
  assert(us.behavior.alertLevel === 'high', 'FOCUSED: alertLevel=high');
  assert(us.behavior.queue === true, 'FOCUSED: queue=true');

  // DND
  us.transition(UserStates.DND, 'test');
  assert(us.behavior.proactive === false, 'DND: proactive=false');
  assert(us.behavior.alertLevel === 'none', 'DND: alertLevel=none');
  assert(us.behavior.logOnly === true, 'DND: logOnly=true');
  assert(us.behavior.queue === false, 'DND: queue=false');
}

// ═══════════════════════════════════════════════════════════════
//  7. ALERT QUEUE — IN_CALL
// ═══════════════════════════════════════════════════════════════

section('7. Alert Queue — IN_CALL');
{
  const us = await createFresh();
  us.transition(UserStates.IN_CALL, 'test');

  const r1 = us.submitAlert({ priority: 'normal', message: 'Test alert 1', source: 'test' });
  assert(r1 === 'queued', 'Normal alert queued during IN_CALL');

  const r2 = us.submitAlert({ priority: 'high', message: 'Urgent alert', source: 'test' });
  assert(r2 === 'queued', 'High alert also queued during IN_CALL (alertLevel=none)');

  const status = us.getStatus();
  assert(status.queuedAlerts === 2, '2 alerts in queue');

  // Transition to AVAILABLE → drain
  let drainedViaEvent = null;
  us.on('alerts:drained', (alerts) => { drainedViaEvent = alerts; });

  const result = us.transition(UserStates.AVAILABLE, 'call_done');
  assert(result.drained.length === 2, 'Drained 2 alerts on → AVAILABLE');
  assert(drainedViaEvent?.length === 2, 'alerts:drained event fired');
  assert(us.getStatus().queuedAlerts === 0, 'Queue empty after drain');
}

// ═══════════════════════════════════════════════════════════════
//  8. ALERT QUEUE — FOCUSED (high gets through)
// ═══════════════════════════════════════════════════════════════

section('8. Alert Queue — FOCUSED');
{
  const us = await createFresh();
  us.transition(UserStates.FOCUSED, 'test');

  let deliveredAlert = null;
  us.on('alert', (a) => { deliveredAlert = a; });

  const r1 = us.submitAlert({ priority: 'normal', message: 'Normal alert', source: 'test' });
  assert(r1 === 'queued', 'Normal alert queued during FOCUSED');
  assert(deliveredAlert === null, 'Normal alert not delivered');

  const r2 = us.submitAlert({ priority: 'high', message: 'Urgent!', source: 'test' });
  assert(r2 === 'delivered', 'High alert delivered during FOCUSED');
  assert(deliveredAlert?.message === 'Urgent!', 'Alert event contains correct message');

  assert(us.getStatus().queuedAlerts === 1, '1 normal alert still queued');
}

// ═══════════════════════════════════════════════════════════════
//  9. DND — LOG ONLY
// ═══════════════════════════════════════════════════════════════

section('9. DND — Log Only');
{
  const us = await createFresh();
  us.transition(UserStates.DND, 'test');

  const r1 = us.submitAlert({ priority: 'high', message: 'Urgent!', source: 'test' });
  assert(r1 === 'logged', 'High alert just logged during DND');

  const r2 = us.submitAlert({ priority: 'normal', message: 'Normal', source: 'test' });
  assert(r2 === 'logged', 'Normal alert just logged during DND');

  assert(us.getStatus().queuedAlerts === 0, 'Nothing queued in DND');
}

// ═══════════════════════════════════════════════════════════════
// 10. AVAILABLE — IMMEDIATE DELIVERY
// ═══════════════════════════════════════════════════════════════

section('10. AVAILABLE — Immediate Delivery');
{
  const us = await createFresh();

  let deliveredAlert = null;
  us.on('alert', (a) => { deliveredAlert = a; });

  const r = us.submitAlert({ priority: 'normal', message: 'Hello', source: 'test' });
  assert(r === 'delivered', 'Alert delivered immediately when AVAILABLE');
  assert(deliveredAlert?.message === 'Hello', 'Alert event fired');
}

// ═══════════════════════════════════════════════════════════════
// 11. QUEUE OVERFLOW
// ═══════════════════════════════════════════════════════════════

section('11. Queue Overflow (max 50)');
{
  const us = await createFresh();
  us.transition(UserStates.IN_CALL, 'test');

  for (let i = 0; i < 60; i++) {
    us.submitAlert({ priority: 'normal', message: `Alert ${i}`, source: 'test' });
  }

  assert(us.getStatus().queuedAlerts <= 50, 'Queue capped at 50');
}

// ═══════════════════════════════════════════════════════════════
// 12. EVENTS
// ═══════════════════════════════════════════════════════════════

section('12. Events');
{
  const us = await createFresh();

  let transitionRecord = null;
  let enterRecord = null;
  let exitRecord = null;

  us.on('transition', (r) => { transitionRecord = r; });
  us.on('enter:IN_CALL', (r) => { enterRecord = r; });
  us.on('exit:AVAILABLE', (r) => { exitRecord = r; });

  us.transition(UserStates.IN_CALL, 'test_trigger');

  assert(transitionRecord !== null, 'transition event fired');
  assert(transitionRecord.from === 'AVAILABLE', 'transition.from correct');
  assert(transitionRecord.to === 'IN_CALL', 'transition.to correct');
  assert(transitionRecord.trigger === 'test_trigger', 'transition.trigger correct');
  assert(enterRecord !== null, 'enter:IN_CALL event fired');
  assert(exitRecord !== null, 'exit:AVAILABLE event fired');
}

// ═══════════════════════════════════════════════════════════════
// 13. VOICE COMMAND DETECTION
// ═══════════════════════════════════════════════════════════════

section('13. Voice Command Detection');
{
  const us = await createFresh();

  const r1 = us.detectStateCommand("I'm on a call");
  assert(r1?.match === true, '"I\'m on a call" detected');
  assert(r1?.target === UserStates.IN_CALL, 'Maps to IN_CALL');

  const r2 = us.detectStateCommand("I'm back");
  assert(r2?.match === true, '"I\'m back" detected');
  assert(r2?.target === UserStates.AVAILABLE, 'Maps to AVAILABLE');

  const r3 = us.detectStateCommand('focus mode');
  assert(r3?.match === true, '"focus mode" detected');
  assert(r3?.target === UserStates.FOCUSED, 'Maps to FOCUSED');

  const r4 = us.detectStateCommand('do not disturb');
  assert(r4?.match === true, '"do not disturb" detected');
  assert(r4?.target === UserStates.DND, 'Maps to DND');

  const r5 = us.detectStateCommand("what's on my calendar");
  assert(r5 === null, 'Non-state command returns null');

  const r6 = us.detectStateCommand('dnd mode');
  assert(r6?.match === true, '"dnd mode" detected');
  assert(r6?.target === UserStates.DND, 'Maps to DND');

  const r7 = us.detectStateCommand("call's done");
  assert(r7?.match === true, '"call\'s done" detected');
  assert(r7?.target === UserStates.AVAILABLE, 'Maps to AVAILABLE');
}

// ═══════════════════════════════════════════════════════════════
// 14. CONFIRMATION MESSAGES
// ═══════════════════════════════════════════════════════════════

section('14. Confirmation Messages');
{
  const us = await createFresh();

  const c1 = us.getConfirmation(UserStates.AVAILABLE);
  assert(typeof c1 === 'string' && c1.length > 0, 'AVAILABLE confirmation is non-empty string');

  const c2 = us.getConfirmation(UserStates.IN_CALL);
  assert(typeof c2 === 'string' && c2.length > 0, 'IN_CALL confirmation is non-empty string');

  const c3 = us.getConfirmation(UserStates.FOCUSED);
  assert(typeof c3 === 'string' && c3.length > 0, 'FOCUSED confirmation is non-empty string');

  const c4 = us.getConfirmation(UserStates.DND);
  assert(typeof c4 === 'string' && c4.length > 0, 'DND confirmation is non-empty string');
}

// ═══════════════════════════════════════════════════════════════
// 15. PREVIOUS STATE TRACKING
// ═══════════════════════════════════════════════════════════════

section('15. Previous State Tracking');
{
  const us = await createFresh();
  us.transition(UserStates.IN_CALL, 'test');
  us.transition(UserStates.AVAILABLE, 'test');

  const status = us.getStatus();
  assert(status.previousState === 'IN_CALL', 'previousState tracks last state');
}

// ═══════════════════════════════════════════════════════════════
// 16. USER_STATE_PATTERNS EXPORT
// ═══════════════════════════════════════════════════════════════

section('16. Pattern Export');
{
  assert(Array.isArray(USER_STATE_PATTERNS), 'USER_STATE_PATTERNS is an array');
  assert(USER_STATE_PATTERNS.length > 0, 'Has patterns defined');
  assert(Object.isFrozen(USER_STATE_PATTERNS), 'Patterns are frozen');

  for (const p of USER_STATE_PATTERNS) {
    assert(p.pattern instanceof RegExp, `Pattern is a RegExp: ${p.pattern}`);
    assert(UserStates[p.target], `Target is a valid state: ${p.target}`);
  }
}

// ═══════════════════════════════════════════════════════════════

console.log(`\n${'═'.repeat(60)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`${'═'.repeat(60)}`);
process.exit(failed > 0 ? 1 : 0);
