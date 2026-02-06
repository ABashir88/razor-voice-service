# CLAUDE.md — Razor Engineering Law

> **This file is the source of truth.** Every agent reads this before writing a single line of code.
> If something conflicts with CLAUDE.md, CLAUDE.md wins — always.

---

## What Is Razor

Razor is a proactive AI voice sales assistant that runs 24/7 on a Mac Mini with an Ortizan X8 Pro Bluetooth speaker. It listens for a wake word, processes speech through an AI brain, and speaks responses. It connects to Salesloft, Salesforce, Gmail, Google Calendar, Fellow, and Brave Search to be a real-time sales partner.

**Razor is not a demo. It is a production system used daily for enterprise sales.**

---

## Project Root

```
~/razor-voice-service/
```

All paths in this document are relative to this root unless stated otherwise.

---

## Runtime Environment

- **Platform:** macOS (Mac Mini, Apple Silicon)
- **Node.js:** >= 20.0.0, ES modules (`"type": "module"` in package.json)
- **Python:** >= 3.11 (Brain Agent only, runs as separate microservice)
- **Audio:** sox, afplay, blueutil, SwitchAudioSource (installed via Homebrew)
- **Process manager:** The system runs as foreground processes during development. PM2 or launchd for production later.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     Intelligence Agent                       │
│              (PULSE, triggers, thinking loops)                │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│   ┌──────────┐   ┌──────────┐   ┌────────────────────────┐  │
│   │  Voice    │   │  Brain   │   │  Integration Agent     │  │
│   │  Pipeline │◄─►│  Engine  │◄─►│  (SL/SF/Gmail/Cal/    │  │
│   │  (Node)   │   │ (Python) │   │   Fellow/Brave)        │  │
│   └────┬─────┘   └────┬─────┘   └────────────────────────┘  │
│        │              │                                      │
│   ┌────▼──────────────▼──────────────────────────────────┐   │
│   │              Memory Agent                             │   │
│   │  (Working / Episodic / Semantic / Procedural)         │   │
│   └──────────────────────┬───────────────────────────────┘   │
│                          │                                    │
│   ┌──────────────────────▼───────────────────────────────┐   │
│   │              State Machine (Foundation)                │   │
│   │         10 states, event-driven, guarded              │   │
│   └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

---

## Directory Structure

```
razor-voice-service/
├── CLAUDE.md                    ← YOU ARE HERE (engineering law)
├── .env                         ← API keys (never committed)
├── .env.example                 ← Template for .env
├── package.json                 ← Node.js dependencies
│
├── src/
│   ├── index.js                 ← Main entry point
│   ├── config.js                ← Central config (reads .env)
│   │
│   ├── state/                   ← Phase 1 ✅
│   │   ├── stateConfig.js       ← States, transitions, timeouts
│   │   └── stateMachine.js      ← EventEmitter-based state machine
│   │
│   ├── pipeline/                ← Phase 2 ✅
│   │   ├── voice-pipeline.js    ← Main orchestrator (uses state machine)
│   │   └── interruption-handler.js
│   │
│   ├── audio/                   ← Phase 2 ✅
│   │   ├── capture.js           ← Mic input via sox
│   │   ├── playback.js          ← Speaker output via afplay
│   │   └── bluetooth.js         ← Ortizan X8 Pro connection
│   │
│   ├── vad/                     ← Phase 2 ✅
│   │   └── vad-engine.js        ← Energy-based voice activity detection
│   │
│   ├── wake-word/               ← Phase 2 ✅
│   │   ├── index.js             ← Strategy selector (Porcupine or transcript)
│   │   ├── porcupine-detector.js
│   │   └── transcript-detector.js
│   │
│   ├── stt/                     ← Phase 2 ✅
│   │   └── deepgram-stream.js   ← WebSocket streaming to Deepgram
│   │
│   ├── tts/                     ← Phase 2 ✅
│   │   └── tts-engine.js        ← Dual provider (Telnyx + ElevenLabs)
│   │
│   ├── memory/                  ← Phase 3 ✅
│   │   ├── index.js             ← MemoryAgent unified API
│   │   ├── working-memory.js    ← Volatile session context
│   │   ├── episodic-memory.js   ← Conversation history (monthly shards)
│   │   ├── semantic-memory.js   ← Knowledge graph (contacts/accounts/deals)
│   │   ├── procedural-memory.js ← Sales playbook (techniques + objections)
│   │   ├── learning-loop.js     ← Post-conversation learning
│   │   ├── memory-file.js       ← MEMORY.md generator
│   │   ├── store.js             ← Atomic JSON persistence
│   │   └── cli.js               ← Maintenance CLI
│   │
│   ├── integrations/            ← Phase 5 (building now)
│   │   ├── index.js             ← Integration Manager
│   │   ├── config.js            ← API key validation
│   │   ├── salesloft.js
│   │   ├── salesforce.js
│   │   ├── google.js            ← Gmail + Calendar
│   │   ├── fellow.js
│   │   └── brave-search.js
│   │
│   ├── intelligence/            ← Phase 6 (future)
│   │   └── ...
│   │
│   └── utils/
│       ├── logger.js            ← Shared logger
│       ├── setup.js             ← Dependency checker
│       ├── test-mic.js
│       ├── test-playback.js
│       └── test-bluetooth.js
│
├── brain/                       ← Python microservice
│   ├── pyproject.toml
│   ├── razor_brain/
│   │   ├── __init__.py
│   │   ├── engine.py            ← Conversation processing pipeline
│   │   ├── gateway.py           ← OpenClaw WebSocket client
│   │   ├── context.py           ← Rolling context window
│   │   ├── prompts.py           ← System prompts for AI brain
│   │   ├── state.py             ← Conversation state tracker
│   │   ├── server.py            ← WebSocket + REST server (port 8780)
│   │   └── examples.py
│   └── tests/
│       └── test_engine.py
│
├── scripts/
│   └── oauth-setup.js           ← One-time OAuth token capture
│
├── data/                        ← Memory persistence (JSON files)
│   ├── sessions/
│   ├── semantic/
│   ├── episodic/
│   ├── procedural/
│   └── learning/
│
├── tests/
│   ├── stateMachine.test.js     ← 64 tests ✅
│   ├── memory.test.js           ← 51 tests ✅
│   └── integrations.test.js
│
├── README.md
└── VOICE_RESEARCH.md
```

---

## The 10 Golden Rules

### 1. The State Machine Is The Nervous System

Every component reads state before acting. Every significant action transitions state.

```js
import { getStateMachine, States } from '../state/stateMachine.js';
const sm = getStateMachine();

// Check state before acting
if (sm.getState().state !== States.LISTENING) return;

// Transition with a reason
sm.transition(States.PROCESSING, 'speech_end');

// Subscribe to transitions
sm.on('transition', (record) => { /* { from, to, trigger, timestamp, metadata } */ });

// Hook into specific states
sm.onEnter(States.LEARNING, (record) => { /* trigger reflection */ });
```

**Never track state yourself.** No `this.state = 'listening'`. No `const State = { ... }`. Use the shared singleton.

**If you need to transition inside an `onEnter` hook, use `process.nextTick()`.** Synchronous re-entry is blocked.

### 2. ES Modules Only

Every file uses `import`/`export`. No `require()`. No CommonJS. The package.json has `"type": "module"`.

```js
// ✅ Correct
import EventEmitter from 'eventemitter3';
import config from '../config.js';
import makeLogger from '../utils/logger.js';

// ❌ Wrong
const EventEmitter = require('eventemitter3');
```

### 3. All Config From Environment

No hardcoded API keys, URLs, or credentials. Everything comes from `.env` via `src/config.js`.

```js
import config from '../config.js';
// Access: config.stt.deepgramApiKey, config.tts.telnyx.apiKey, etc.
```

For new integrations, extend `config.js` or create a module-specific config that reads from `process.env`.

### 4. Use The Shared Logger

```js
import makeLogger from '../utils/logger.js';
const log = makeLogger('ModuleName');

log.info('Starting up');
log.warn('Something unexpected');
log.error('Failed:', err.message);
log.debug('Verbose detail');
```

### 5. No Standalone Packages

Everything lives inside the main project under `src/`. Do NOT create separate `package.json` files, separate npm packages, or standalone services (except the Brain Agent which is an approved Python exception).

```
// ✅ Correct: src/memory/index.js
// ❌ Wrong: memory-agent/package.json with its own npm install
```

### 6. Graceful Degradation

If a component fails, the system keeps running. Missing API key? That integration is disabled, not crashed. Bluetooth disconnected? Fall back to built-in audio. Brain server down? Queue the request and retry.

```js
// ✅ Correct
try {
  const result = await salesloft.getPeople(name);
} catch (err) {
  log.warn('Salesloft unavailable:', err.message);
  return null; // Caller handles gracefully
}

// ❌ Wrong
const result = await salesloft.getPeople(name); // Unhandled rejection kills the process
```

### 7. Events Over Polling

Components communicate through EventEmitter events, not by polling each other.

```js
// ✅ Correct: subscribe to state transitions
sm.onEnter(States.LEARNING, async () => { await memory.reflect(); });

// ❌ Wrong: polling loop
setInterval(() => { if (sm.getState().state === 'LEARNING') memory.reflect(); }, 1000);
```

### 8. Atomic Writes For Persistence

All file writes use the write-to-temp-then-rename pattern. The Memory Agent's `Store` class handles this. If you need to persist data, use it:

```js
import Store from '../memory/store.js';
const store = new Store('data');
await store.write('mykey', { data: 'value' });  // Atomic: writes .tmp, renames
const data = await store.read('mykey', {});      // Returns default if missing
```

### 9. Zero Hardcoded Commands

The Brain Agent processes natural language. No regex matching. No keyword detection. No `if (input.includes('call'))` logic anywhere. Every user utterance goes to the AI brain untouched. The brain infers intent, entities, and state.

### 10. Tests For Every Module

Every module ships with tests. Tests must pass before the module is approved. Use this pattern:

```js
// tests/myModule.test.js
let passed = 0, failed = 0;

function assert(condition, label) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.log(`  ✗ ${label}`); failed++; }
}

// ... tests ...

console.log(`\n═══ Results: ${passed} passed, ${failed} failed ═══`);
process.exit(failed > 0 ? 1 : 0);
```

No external test frameworks required (but allowed if the module warrants it).

---

## Existing APIs You Must Use

### State Machine API

**Import:** `import { getStateMachine, States } from '../state/stateMachine.js';`

**Singleton:** `const sm = getStateMachine();`

| Method | Returns | Purpose |
|--------|---------|---------|
| `sm.transition(state, trigger, metadata?)` | `{ ok, error? }` | Request a state transition |
| `sm.getState()` | `{ state, context, enteredAt, elapsed }` | Current state + context |
| `sm.canTransition(state)` | `boolean` | Check if transition is legal |
| `sm.onEnter(state, callback)` | `unsubscribe fn` | Hook when entering a state |
| `sm.onExit(state, callback)` | `unsubscribe fn` | Hook when leaving a state |
| `sm.addGuard(from, to, guardFn)` | `unsubscribe fn` | Block transition unless guardFn returns true |
| `sm.getHistory(n?)` | `Array` | Last n transitions |
| `sm.forceReset()` | void | Emergency reset to IDLE |

**States:** `IDLE`, `LISTENING`, `PROCESSING`, `SPEAKING`, `INTERRUPTED`, `BRIEFING`, `RESEARCHING`, `COACHING`, `LEARNING`, `ERROR`

**Events:** `sm.on('transition', ({ from, to, trigger, timestamp, metadata }) => {})`

### Memory Agent API

**Import:** `import MemoryAgent from '../memory/index.js';`

| Method | Purpose |
|--------|---------|
| `memory.startConversation({ contactId, dealId, topic })` | Preload context for a conversation |
| `memory.addTurn(role, content, metadata?)` | Record a conversation turn |
| `memory.endConversation(analysis)` | Trigger learning loop + persist |
| `memory.handleObjection(text)` | Find best objection response |
| `memory.suggestTechnique(category, signal?)` | Get technique recommendation |
| `memory.getContext()` | Current working memory as string |
| `memory.search(query)` | Search across all memory tiers |
| `memory.semantic.upsertContact(data)` | Create/update a contact |
| `memory.semantic.buildDealContext(dealId)` | Full deal brief for LLM |
| `memory.episodic.buildContactContext(contactId)` | Contact interaction history |

**Events:** `memory.on('memory:stored', ...)`, `memory.on('memory:reflected', ...)`

### Voice Pipeline API

**Import:** `import VoicePipeline from '../pipeline/voice-pipeline.js';`

| Method | Purpose |
|--------|---------|
| `pipeline.init()` | Initialize all audio components |
| `pipeline.start()` | Begin listening |
| `pipeline.stop()` | Shutdown |
| `pipeline.speak(text, { pace })` | Synthesize and play speech |
| `pipeline.getState()` | Current state string |

**Events:** `pipeline.on('command', ({ text, source }))`, `pipeline.on('command:partial', ...)`, `pipeline.on('state', ...)`

### Brain Server API

**Protocol:** WebSocket at `ws://localhost:8780/ws`

**Send:**
```json
{ "text": "user transcript", "metadata": {}, "stream": false }
```

**Receive:**
```json
{
  "type": "response",
  "text": "brain response",
  "intent": "call_debrief",
  "state": "debriefing",
  "actions": [{ "action": "log_call", "params": {} }],
  "entities": [{ "name": "Marcus", "type": "person" }],
  "follow_up": "Want me to draft a follow-up?"
}
```

**REST endpoints:** `GET /health`, `GET /status`, `POST /process`, `POST /session/new`

### Config Pattern

**Import:** `import config from '../config.js';`

Config uses `Object.freeze()` for immutability. To add new config sections, follow the existing pattern with `env()`, `envInt()`, and `envFloat()` helpers.

---

## Integration Requirements

When building integration clients, follow this pattern:

```js
import makeLogger from '../utils/logger.js';

const log = makeLogger('Salesloft');

export class SalesloftClient {
  constructor(apiKey) {
    if (!apiKey) throw new Error('SALESLOFT_API_KEY is required');
    this.apiKey = apiKey;
    this.baseUrl = 'https://api.salesloft.com/v2';
  }

  async _request(method, path, body = null) {
    // Implement: rate limiting, retry with backoff, error handling
  }

  async getPeople(query) { /* ... */ }
  async logCall(personId, data) { /* ... */ }
}
```

**Rules for all integrations:**
- Rate limit per service (token bucket or simple queue)
- Retry transient errors (429, 500, 502, 503) with exponential backoff
- Throw clear errors on auth failures — don't retry those
- Return `null` or empty arrays on "not found" — don't throw
- Log every API call at debug level, errors at error level
- Each integration is independently optional

---

## Two-Runtime Architecture

The Brain runs as a Python process. Everything else is Node.js. They communicate over WebSocket:

```
Node.js (port 3000)  ◄── WebSocket ──►  Python Brain (port 8780)
  Voice Pipeline                           ConversationEngine
  State Machine                            OpenClaw Gateway
  Memory Agent                             Context Manager
  Integrations                             State Tracker
  Intelligence
```

**The Node.js state machine (`stateMachine.js`) tracks system states** (IDLE, LISTENING, PROCESSING, etc.).
**The Python state tracker (`state.py`) tracks conversation states** (debriefing, querying, clarifying, etc.).

These are separate layers — mechanical vs semantic. Both exist and are correct.

---

## Error Handling Standard

```js
// Module-level errors: catch, log, degrade
try {
  await riskyOperation();
} catch (err) {
  log.error('Operation failed:', err.message);
  // Degrade gracefully — return default, skip, or retry
}

// Process-level errors: catch in index.js
process.on('uncaughtException', (err) => {
  log.error('Uncaught exception:', err);
  // Attempt graceful shutdown
});
```

**Never let an unhandled promise rejection crash the service.** Razor runs 24/7.

---

## What NOT To Do

- ❌ Create your own state tracking (`this.state = 'listening'`)
- ❌ Use CommonJS (`require()`)
- ❌ Create standalone packages with their own `package.json`
- ❌ Hardcode API keys or credentials
- ❌ Match commands with regex or keywords
- ❌ Use `console.log` — use the shared logger
- ❌ Write to files without atomic writes
- ❌ Poll for state changes — subscribe to events
- ❌ Ignore errors — always catch and handle
- ❌ Overwrite existing modules unless specifically asked to patch them
- ❌ Use Python for anything other than the Brain Agent
- ❌ Add unnecessary npm dependencies

---

## Build Status

| Phase | Agent | Status | Tests |
|-------|-------|--------|-------|
| 1 | State Machine | ✅ Complete | 64/64 |
| 2 | Voice Pipeline | ✅ Complete | Approved |
| 3 | Memory Agent | ✅ Complete | 51/51 |
| 4 | Brain Agent | ✅ Complete (Python) | Approved |
| 5 | Integration Agent | 🔨 Building | — |
| 6 | Intelligence Agent | ⏳ Waiting | — |

---

## Quality Bar

Every module delivered must:
- Pass all its tests
- Use the shared state machine (if it needs state awareness)
- Use the shared logger
- Handle errors gracefully
- Follow ES module conventions
- Have clear JSDoc on public methods
- Not break any existing module when added to the project

**Default philosophy: boring, bulletproof, maintainable code.**
Modern only when clearly superior and production-proven.
