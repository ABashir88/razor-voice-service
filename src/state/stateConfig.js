// ─────────────────────────────────────────────────────────────
// stateConfig.js — Single source of truth for Razor's state layer
// ─────────────────────────────────────────────────────────────

export const States = Object.freeze({
  IDLE:        'IDLE',
  LISTENING:   'LISTENING',
  PROCESSING:  'PROCESSING',
  SPEAKING:    'SPEAKING',
  INTERRUPTED: 'INTERRUPTED',
  BRIEFING:    'BRIEFING',
  RESEARCHING: 'RESEARCHING',
  COACHING:    'COACHING',
  LEARNING:    'LEARNING',
  ERROR:       'ERROR',
});

/**
 * Default max duration (ms) before auto-timeout.
 * null = no timeout. Override per-instance via timeoutOverrides.
 */
export const StateTimeouts = Object.freeze({
  [States.IDLE]:        null,
  [States.LISTENING]:   null,       // Always listening — no timeout
  [States.PROCESSING]:  90_000,
  [States.SPEAKING]:    120_000,
  [States.INTERRUPTED]: 5_000,
  [States.BRIEFING]:    60_000,
  [States.RESEARCHING]: 15_000,
  [States.COACHING]:    300_000,
  [States.LEARNING]:    10_000,
  [States.ERROR]:       30_000,
});

/** Where each state goes when its timeout fires. */
export const TimeoutTargets = Object.freeze({
  [States.LISTENING]:   States.LISTENING,  // no-op (timeout is null)
  [States.PROCESSING]:  States.ERROR,
  [States.SPEAKING]:    States.LISTENING,
  [States.INTERRUPTED]: States.LISTENING,
  [States.BRIEFING]:    States.LISTENING,
  [States.RESEARCHING]: States.ERROR,
  [States.COACHING]:    States.LISTENING,
  [States.LEARNING]:    States.LISTENING,
  [States.ERROR]:       States.LISTENING,
});

/**
 * Legal transition map.
 * Key = source state, Value = Set of reachable states.
 */
export const TransitionMap = Object.freeze({
  [States.IDLE]: new Set([
    States.LISTENING,    // Wake word / PTT
    States.BRIEFING,     // Razor initiates proactively
    States.COACHING,     // Pre-call coaching
    States.LEARNING,     // Offline reflection
    States.ERROR,        // Hardware fault
  ]),

  [States.LISTENING]: new Set([
    States.PROCESSING,   // Utterance captured → AI brain
    States.IDLE,         // Silence timeout / cancel
    States.ERROR,        // STT failure
  ]),

  [States.PROCESSING]: new Set([
    States.SPEAKING,     // AI response ready → TTS
    States.RESEARCHING,  // AI needs live data first
    States.COACHING,     // AI enters coaching flow
    States.ERROR,        // Timeout / service down
    States.IDLE,         // Informational, no speech needed
  ]),

  [States.SPEAKING]: new Set([
    States.IDLE,         // Finished speaking
    States.LISTENING,    // Expecting user reply
    States.INTERRUPTED,  // User barged in
    States.ERROR,        // TTS / audio failure
  ]),

  [States.INTERRUPTED]: new Set([
    States.LISTENING,    // Re-capture user speech
    States.PROCESSING,   // Partial input captured, send immediately
    States.IDLE,         // User went silent
    States.ERROR,        // Cascading failure
  ]),

  [States.BRIEFING]: new Set([
    States.SPEAKING,     // Briefing content ready → TTS
    States.RESEARCHING,  // Need data before briefing
    States.LISTENING,    // User responds during setup
    States.IDLE,         // Cancelled
    States.ERROR,        // Failure
  ]),

  [States.RESEARCHING]: new Set([
    States.PROCESSING,   // Data retrieved → AI brain
    States.SPEAKING,     // Self-contained data, speak directly
    States.COACHING,     // Research feeds coaching
    States.ERROR,        // Integration timeout / auth fail
    States.IDLE,         // Cancelled
  ]),

  [States.COACHING]: new Set([
    States.SPEAKING,     // Coach has advice
    States.LISTENING,    // Awaiting user reply
    States.RESEARCHING,  // Coach needs more data
    States.PROCESSING,   // User input needs AI processing
    States.IDLE,         // Session ends
    States.ERROR,        // Failure
  ]),

  [States.LEARNING]: new Set([
    States.IDLE,         // Reflection complete (explicit only, e.g. shutdown)
    States.LISTENING,    // Reflection complete → resume listening
    States.ERROR,        // Memory write failed
  ]),

  [States.ERROR]: new Set([
    States.IDLE,         // Recovery to baseline
    States.LISTENING,    // Soft recovery — retry capture
    States.PROCESSING,   // Retry AI call
  ]),
});

export const defaultContext = () => ({
  conversationId:     null,
  userId:             null,
  emotionalTone:      'neutral',
  urgencyLevel:       0,
  activeIntegrations: [],
  metadata:           {},
});

export const HISTORY_BUFFER_SIZE = 50;
