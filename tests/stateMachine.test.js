/**
 * stateMachine.test.js
 * Run:  node tests/stateMachine.test.js
 */
import { createStateMachine, States } from '../src/state/stateMachine.js';

let passed = 0, failed = 0;

function assert(cond, label) {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else      { console.log(`  ❌ ${label}`); failed++; }
}
function section(t) {
  console.log(`\n${'═'.repeat(60)}\n  ${t}\n${'═'.repeat(60)}`);
}

// 1. Happy path
section('1. Happy Path: IDLE → LISTEN → PROCESS → SPEAK → IDLE');
{
  const sm = createStateMachine({ verbose: true });
  assert(sm.getState().state === 'IDLE', 'Starts in IDLE');
  assert(sm.transition('LISTENING', 'wake_word').ok,             'IDLE → LISTENING');
  assert(sm.transition('PROCESSING', 'stt_complete').ok,         'LISTENING → PROCESSING');
  assert(sm.transition('SPEAKING', 'ai_response_ready').ok,      'PROCESSING → SPEAKING');
  assert(sm.transition('IDLE', 'tts_finished').ok,               'SPEAKING → IDLE');
  sm.destroy();
}

// 2. Illegal transitions
section('2. Illegal Transitions');
{
  const sm = createStateMachine();
  assert(!sm.transition('SPEAKING', 'shortcut').ok,    'IDLE → SPEAKING blocked');
  assert(!sm.transition('PROCESSING', 'shortcut').ok,  'IDLE → PROCESSING blocked');
  assert(!sm.transition('INTERRUPTED', 'shortcut').ok, 'IDLE → INTERRUPTED blocked');
  sm.destroy();
}

// 3. canTransition
section('3. canTransition()');
{
  const sm = createStateMachine();
  assert(sm.canTransition('LISTENING'),    'IDLE can → LISTENING');
  assert(sm.canTransition('BRIEFING'),     'IDLE can → BRIEFING');
  assert(!sm.canTransition('SPEAKING'),    'IDLE cannot → SPEAKING');
  assert(!sm.canTransition('PROCESSING'),  'IDLE cannot → PROCESSING');
  sm.transition('LISTENING', 'test');
  assert(sm.canTransition('PROCESSING'),   'LISTENING can → PROCESSING');
  assert(!sm.canTransition('SPEAKING'),    'LISTENING cannot → SPEAKING');
  sm.destroy();
}

// 4. Interrupt flow
section('4. Interrupt: SPEAKING → INTERRUPTED → LISTENING');
{
  const sm = createStateMachine({ verbose: true });
  sm.transition('LISTENING', 'wake_word');
  sm.transition('PROCESSING', 'stt_complete');
  sm.transition('SPEAKING', 'ai_response_ready');
  assert(sm.transition('INTERRUPTED', 'user_barge_in').ok, 'SPEAKING → INTERRUPTED');
  assert(sm.transition('LISTENING', 're_listen').ok,       'INTERRUPTED → LISTENING');
  sm.destroy();
}

// 5. Briefing (proactive, skips LISTENING)
section('5. Briefing: IDLE → BRIEFING → SPEAKING → IDLE');
{
  const sm = createStateMachine({ verbose: true });
  assert(sm.transition('BRIEFING', 'scheduled_trigger').ok, 'IDLE → BRIEFING');
  assert(sm.transition('SPEAKING', 'briefing_ready').ok,    'BRIEFING → SPEAKING');
  assert(sm.transition('IDLE', 'tts_finished').ok,          'SPEAKING → IDLE');
  sm.destroy();
}

// 6. Research detour
section('6. Research: PROCESSING → RESEARCHING → PROCESSING → SPEAKING');
{
  const sm = createStateMachine({ verbose: true });
  sm.transition('LISTENING', 'wake_word');
  sm.transition('PROCESSING', 'stt_complete');
  assert(sm.transition('RESEARCHING', 'needs_crm_data').ok,  'PROCESSING → RESEARCHING');
  assert(sm.transition('PROCESSING', 'data_retrieved').ok,    'RESEARCHING → PROCESSING');
  assert(sm.transition('SPEAKING', 'ai_response_ready').ok,   'PROCESSING → SPEAKING');
  sm.destroy();
}

// 7. Coaching
section('7. Coaching: IDLE → COACHING → SPEAKING → LISTENING → PROCESSING');
{
  const sm = createStateMachine({ verbose: true });
  assert(sm.transition('COACHING', 'pre_call_trigger').ok,      'IDLE → COACHING');
  assert(sm.transition('SPEAKING', 'coach_advice').ok,          'COACHING → SPEAKING');
  assert(sm.transition('LISTENING', 'expecting_user_reply').ok, 'SPEAKING → LISTENING');
  assert(sm.transition('PROCESSING', 'stt_complete').ok,        'LISTENING → PROCESSING');
  sm.destroy();
}

// 8. Learning
section('8. Learning: IDLE → LEARNING → IDLE');
{
  const sm = createStateMachine({ verbose: true });
  assert(sm.transition('LEARNING', 'post_call_reflection').ok, 'IDLE → LEARNING');
  assert(sm.transition('IDLE', 'reflection_complete').ok,      'LEARNING → IDLE');
  sm.destroy();
}

// 9. Error + recovery
section('9. Error Recovery: PROCESSING → ERROR → IDLE');
{
  const sm = createStateMachine({ verbose: true });
  sm.transition('LISTENING', 'wake_word');
  sm.transition('PROCESSING', 'stt_complete');
  assert(sm.transition('ERROR', 'ai_timeout').ok,    'PROCESSING → ERROR');
  assert(sm.transition('IDLE', 'error_recovered').ok, 'ERROR → IDLE');
  sm.destroy();
}

// 10. Guards
section('10. Transition Guards');
{
  const sm = createStateMachine();
  const unsub = sm.addGuard('IDLE', 'LISTENING', (ctx) => ctx.userId !== null);
  assert(!sm.transition('LISTENING', 'wake_word').ok, 'Guard blocks (no userId)');
  sm.updateContext({ userId: 'user_001' });
  assert(sm.transition('LISTENING', 'wake_word').ok,  'Guard passes after update');
  sm.transition('IDLE', 'test_reset');
  unsub();
  sm.updateContext({ userId: null });
  assert(sm.transition('LISTENING', 'wake_word').ok,  'Guard unsubscribed — allowed');
  sm.destroy();
}

// 11. Lifecycle hooks
section('11. Lifecycle Hooks');
{
  const sm = createStateMachine();
  const log = [];
  const u1 = sm.onEnter('LISTENING', (d) => log.push(`entered from ${d.from}`));
  const u2 = sm.onExit('LISTENING',  (d) => log.push(`exited to ${d.target}`));
  sm.transition('LISTENING', 'wake_word');
  sm.transition('PROCESSING', 'stt_complete');
  assert(log[0] === 'entered from IDLE',          'onEnter correct');
  assert(log[1] === 'exited to PROCESSING',       'onExit correct');
  u1(); u2();
  sm.transition('SPEAKING', 'ai_response_ready');
  sm.transition('LISTENING', 'expecting_reply');
  assert(log.length === 2, 'No hooks after unsub');
  sm.destroy();
}

// 12. EventEmitter
section('12. EventEmitter');
{
  const sm = createStateMachine();
  const evts = [];
  sm.on('transition', (r) => evts.push(r));
  sm.transition('LISTENING', 'wake_word', { foo: 'bar' });
  sm.transition('PROCESSING', 'stt_complete');
  assert(evts.length === 2,                                      '2 events');
  assert(evts[0].from === 'IDLE' && evts[0].to === 'LISTENING', 'Shape correct');
  assert(evts[0].trigger === 'wake_word',                        'Trigger preserved');
  assert(evts[0].metadata.foo === 'bar',                         'Metadata preserved');
  assert(typeof evts[0].timestamp === 'number',                  'Timestamp present');
  assert(typeof evts[0].durationInPrevState === 'number',        'Duration present');
  sm.destroy();
}

// 13. Context via metadata.contextUpdate
section('13. Context Updates');
{
  const sm = createStateMachine({ context: { userId: 'u1' } });
  sm.transition('LISTENING', 'wake_word', {
    contextUpdate: { conversationId: 'conv_42', emotionalTone: 'frustrated', urgencyLevel: 7 },
  });
  const s = sm.getState();
  assert(s.context.conversationId === 'conv_42',    'conversationId set');
  assert(s.context.emotionalTone === 'frustrated',   'emotionalTone set');
  assert(s.context.urgencyLevel === 7,               'urgencyLevel set');
  assert(s.context.userId === 'u1',                  'Existing context preserved');
  sm.destroy();
}

// 14. History
section('14. History Buffer');
{
  const sm = createStateMachine();
  for (let i = 0; i < 10; i++) {
    sm.transition('LISTENING', `t_${i}`);
    sm.transition('IDLE', `t_${i}_b`);
  }
  assert(sm.getHistory().length === 20,  '20 recorded');
  assert(sm.getHistory(3).length === 3,  'getHistory(3) = 3');
  assert(sm.getHistory(1)[0].to === 'IDLE', 'Most recent correct');
  sm.destroy();
}

// 15. Ring buffer overflow
section('15. History Ring Buffer (max 50)');
{
  const sm = createStateMachine();
  for (let i = 0; i < 30; i++) {
    sm.transition('LISTENING', `f_${i}`);
    sm.transition('IDLE', `f_${i}_b`);
  }
  assert(sm.getHistory().length === 50,            'Capped at 50');
  assert(sm.getHistory()[0].trigger === 'f_5',     'Oldest = f_5');
  sm.destroy();
}

// 16. Force reset
section('16. Force Reset');
{
  const sm = createStateMachine();
  sm.transition('LISTENING', 'w');
  sm.transition('PROCESSING', 's');
  let re = null;
  sm.on('reset', (r) => { re = r; });
  sm.forceReset();
  assert(sm.getState().state === 'IDLE',                'Back to IDLE');
  assert(re !== null,                                    'Reset event');
  assert(re.from === 'PROCESSING',                       'Origin recorded');
  assert(sm.getState().context.conversationId === null,  'Context wiped');
  sm.destroy();
}

// 17. Duplicate transition
section('17. Duplicate Transition');
{
  const sm = createStateMachine();
  sm.transition('LISTENING', 'w');
  const r = sm.transition('LISTENING', 'w2');
  assert(!r.ok,                       'Returns not-ok');
  assert(r.error.includes('Already'), 'Explains duplicate');
  sm.destroy();
}

// 18. Rejected event
section('18. Rejected Event');
{
  const sm = createStateMachine();
  let rej = null;
  sm.on('transition:rejected', (d) => { rej = d; });
  sm.transition('SPEAKING', 'illegal');
  assert(rej !== null,                     'Event fired');
  assert(rej.reason.includes('Illegal'),   'Reason included');
  assert(rej.state === 'IDLE',             'State recorded');
  sm.destroy();
}

// 19. Timeout (accelerated)
section('19. Timeout: PROCESSING 200ms → ERROR');
{
  const sm = createStateMachine({ verbose: true, timeoutOverrides: { PROCESSING: 200 } });
  sm.transition('LISTENING', 'w');
  sm.transition('PROCESSING', 's');
  setTimeout(() => {
    assert(sm.getState().state === 'ERROR',                      'Timed out → ERROR');
    const h = sm.getHistory(1)[0];
    assert(h.trigger === 'timeout:PROCESSING',                   'Trigger recorded');
    assert(h.metadata.timedOut === true,                         'timedOut flag');
    sm.destroy();
    runLast();
  }, 400);
}

// 20. Runtime timeout override
function runLast() {
  section('20. Runtime Timeout Override');
  const sm = createStateMachine({ verbose: true, timeoutOverrides: { LISTENING: 100 } });
  sm.transition('LISTENING', 'w');
  sm.setTimeoutOverride('LISTENING', 5000);
  setTimeout(() => {
    assert(sm.getState().state === 'LISTENING', 'Override prevented timeout');
    sm.destroy();
    console.log(`\n${'═'.repeat(60)}\n  RESULTS: ${passed} passed, ${failed} failed\n${'═'.repeat(60)}`);
    process.exit(failed > 0 ? 1 : 0);
  }, 250);
}
