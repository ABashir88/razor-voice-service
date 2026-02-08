// src/state/user-state.js — User Availability State
//
// Orthogonal to the pipeline state machine (IDLE, LISTENING, PROCESSING, etc.).
// Pipeline states track what Razor is DOING mechanically.
// User states track the USER'S availability, controlling what Razor is ALLOWED to do.
//
// States:
//   AVAILABLE — Normal operation. All alerts, proactive speech enabled.
//   IN_CALL   — User is on a phone call. Queue alerts, don't interrupt.
//   FOCUSED   — Deep work mode. High-priority alerts only.
//   DND       — Do not disturb. Silent, log only.
//
// Singleton — import { userState } from '../state/user-state.js';

import { EventEmitter } from 'events';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import makeLogger from '../utils/logger.js';

const log = makeLogger('UserState');

// ── State Definitions ──────────────────────────────────────────────

export const UserStates = Object.freeze({
  AVAILABLE: 'AVAILABLE',
  IN_CALL:   'IN_CALL',
  FOCUSED:   'FOCUSED',
  DND:       'DND',
});

/**
 * Per-state behavior flags.
 *
 * proactive  — Can Razor initiate speech (briefings, nudges, alerts)?
 * listen     — Should Razor respond to voice commands? (always true — needed to exit any state)
 * alertLevel — 'all' | 'high' | 'none' — what priority alerts get through immediately
 * queue      — Queue blocked alerts for delivery when returning to AVAILABLE?
 * logOnly    — Log alerts silently without queuing for later?
 */
const STATE_BEHAVIOR = Object.freeze({
  [UserStates.AVAILABLE]: { proactive: true,  listen: true, alertLevel: 'all',  queue: false, logOnly: false },
  [UserStates.IN_CALL]:   { proactive: false, listen: true, alertLevel: 'none', queue: true,  logOnly: false },
  [UserStates.FOCUSED]:   { proactive: false, listen: true, alertLevel: 'high', queue: true,  logOnly: false },
  [UserStates.DND]:       { proactive: false, listen: true, alertLevel: 'none', queue: false, logOnly: true  },
});

/**
 * Legal transitions.
 * All states can reach all other states — user can always change availability.
 */
const USER_TRANSITIONS = Object.freeze({
  [UserStates.AVAILABLE]: new Set([UserStates.IN_CALL, UserStates.FOCUSED, UserStates.DND]),
  [UserStates.IN_CALL]:   new Set([UserStates.AVAILABLE, UserStates.FOCUSED, UserStates.DND]),
  [UserStates.FOCUSED]:   new Set([UserStates.AVAILABLE, UserStates.IN_CALL, UserStates.DND]),
  [UserStates.DND]:       new Set([UserStates.AVAILABLE, UserStates.IN_CALL, UserStates.FOCUSED]),
});

/**
 * Voice command patterns for the fallback pattern matcher.
 * Primary intent detection goes through the brain, but these serve as
 * a safety net when the brain returns "." with no actions.
 */
export const USER_STATE_PATTERNS = Object.freeze([
  { pattern: /\b(i'?m on a call|on a call|taking a call|in a call|call mode)\b/i, target: UserStates.IN_CALL },
  { pattern: /\b(i'?m back|back now|off the call|call.?s? (done|over|finished)|done with.* call)\b/i, target: UserStates.AVAILABLE },
  { pattern: /\b(focus mode|focus time|deep work|heads? down|do not interrupt)\b/i, target: UserStates.FOCUSED },
  { pattern: /\b(do not disturb|d\.?n\.?d\.?|dnd mode|go silent|mute yourself|shut up)\b/i, target: UserStates.DND },
  { pattern: /\b(normal mode|available|all clear|resume|come back)\b/i, target: UserStates.AVAILABLE },
]);

// ── Alert Queue ────────────────────────────────────────────────────

const MAX_QUEUED_ALERTS = 50;

// ── Persistence ────────────────────────────────────────────────────

const PERSIST_DIR = 'state';
const PERSIST_FILE = 'user-state.json';

// ── Class ──────────────────────────────────────────────────────────

class UserState extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(20);

    this._state = UserStates.AVAILABLE;
    this._enteredAt = Date.now();
    this._previousState = null;
    this._queuedAlerts = [];
    this._persistPath = null; // Set during init
  }

  // ═══════════════════════════════════════════════════════════════
  //  INIT / PERSISTENCE
  // ═══════════════════════════════════════════════════════════════

  /**
   * Initialize with project root for persistence.
   * @param {string} rootDir — Project root (e.g. config.root)
   */
  async init(rootDir) {
    this._persistPath = join(rootDir, PERSIST_DIR, PERSIST_FILE);
    await this._load();
    log.info(`User state initialized: ${this._state}`);
    return this;
  }

  async _load() {
    try {
      const raw = await readFile(this._persistPath, 'utf8');
      const saved = JSON.parse(raw);

      // Only restore same-day state (reset on new day)
      const savedDate = new Date(saved.enteredAt).toDateString();
      const today = new Date().toDateString();

      if (savedDate === today && UserStates[saved.state]) {
        this._state = saved.state;
        this._enteredAt = saved.enteredAt;
        this._previousState = saved.previousState || null;
        this._queuedAlerts = saved.queuedAlerts || [];
        log.info(`Restored user state: ${this._state}`);
      } else {
        this._state = UserStates.AVAILABLE;
        log.info('New day — user state reset to AVAILABLE');
      }
    } catch {
      // No saved state or parse error — start fresh
      this._state = UserStates.AVAILABLE;
    }
  }

  async _save() {
    if (!this._persistPath) return;
    try {
      const dir = this._persistPath.replace(/\/[^/]+$/, '');
      await mkdir(dir, { recursive: true });

      const tmp = this._persistPath + '.tmp';
      await writeFile(tmp, JSON.stringify({
        state: this._state,
        enteredAt: this._enteredAt,
        previousState: this._previousState,
        queuedAlerts: this._queuedAlerts.slice(-MAX_QUEUED_ALERTS),
      }, null, 2));

      // Atomic rename
      const { rename } = await import('node:fs/promises');
      await rename(tmp, this._persistPath);
    } catch (err) {
      log.warn('Failed to persist user state:', err.message);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  STATE TRANSITIONS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Transition to a new user state.
   *
   * @param  {string} target  — Target state (use UserStates enum)
   * @param  {string} trigger — What caused this ('voice_command', 'api', 'calendar', etc.)
   * @returns {{ ok: boolean, error?: string, drained?: Array }}
   */
  transition(target, trigger = 'manual') {
    if (!UserStates[target]) {
      log.warn(`Unknown user state: "${target}"`);
      return { ok: false, error: `Unknown user state: "${target}"` };
    }

    if (this._state === target) {
      return { ok: true, already: true };
    }

    const allowed = USER_TRANSITIONS[this._state];
    if (!allowed || !allowed.has(target)) {
      log.warn(`Illegal user state transition: ${this._state} → ${target}`);
      return { ok: false, error: `Cannot transition from ${this._state} to ${target}` };
    }

    const from = this._state;
    const timestamp = Date.now();
    const duration = timestamp - this._enteredAt;

    this._previousState = from;
    this._state = target;
    this._enteredAt = timestamp;

    log.info(`User state: ${from} → ${target} [${trigger}] (${duration}ms in prev)`);

    const record = Object.freeze({
      from,
      to: target,
      trigger,
      timestamp,
      durationInPrevState: duration,
    });

    this.emit('transition', record);
    this.emit(`enter:${target}`, record);
    this.emit(`exit:${from}`, record);

    // Drain queued alerts when returning to AVAILABLE
    let drained = [];
    if (target === UserStates.AVAILABLE && this._queuedAlerts.length > 0) {
      drained = this.drainAlerts();
      log.info(`Draining ${drained.length} queued alert(s)`);
      this.emit('alerts:drained', drained);
    }

    this._save();

    return { ok: true, drained };
  }

  // ═══════════════════════════════════════════════════════════════
  //  QUERY API
  // ═══════════════════════════════════════════════════════════════

  /** Current user state string. */
  get state() {
    return this._state;
  }

  /** Behavior flags for the current state. */
  get behavior() {
    return STATE_BEHAVIOR[this._state];
  }

  /** Can Razor initiate speech (briefings, nudges, non-urgent alerts)? */
  get canSpeak() {
    return STATE_BEHAVIOR[this._state].proactive;
  }

  /** What alert level gets through immediately? 'all' | 'high' | 'none' */
  get alertLevel() {
    return STATE_BEHAVIOR[this._state].alertLevel;
  }

  /** Full status snapshot. */
  getStatus() {
    return Object.freeze({
      state: this._state,
      previousState: this._previousState,
      enteredAt: this._enteredAt,
      elapsed: Date.now() - this._enteredAt,
      behavior: { ...STATE_BEHAVIOR[this._state] },
      queuedAlerts: this._queuedAlerts.length,
    });
  }

  // ═══════════════════════════════════════════════════════════════
  //  ALERT MANAGEMENT
  // ═══════════════════════════════════════════════════════════════

  /**
   * Submit an alert. Based on current user state, it will be:
   *  - Delivered immediately (AVAILABLE, or high-priority in FOCUSED)
   *  - Queued for later (IN_CALL, or low-priority in FOCUSED)
   *  - Logged silently (DND)
   *
   * @param {{ priority: 'high'|'normal'|'low', message: string, source: string }} alert
   * @returns {'delivered'|'queued'|'logged'}
   */
  submitAlert(alert) {
    const behavior = STATE_BEHAVIOR[this._state];
    const priority = alert.priority || 'normal';

    // DND — log only, never queue or deliver
    if (behavior.logOnly) {
      log.debug(`Alert logged (DND): [${priority}] ${alert.message}`);
      return 'logged';
    }

    // Check if this priority level gets through
    const delivers =
      behavior.alertLevel === 'all' ||
      (behavior.alertLevel === 'high' && priority === 'high');

    if (delivers) {
      this.emit('alert', alert);
      return 'delivered';
    }

    // Queue for later
    if (behavior.queue) {
      this._queuedAlerts.push({
        ...alert,
        queuedAt: Date.now(),
        queuedDuring: this._state,
      });
      if (this._queuedAlerts.length > MAX_QUEUED_ALERTS) {
        this._queuedAlerts = this._queuedAlerts.slice(-MAX_QUEUED_ALERTS);
      }
      log.debug(`Alert queued (${this._state}): [${priority}] ${alert.message}`);
      this._save();
      return 'queued';
    }

    return 'logged';
  }

  /**
   * Drain all queued alerts. Called automatically on → AVAILABLE transition.
   * @returns {Array} The queued alerts
   */
  drainAlerts() {
    const alerts = [...this._queuedAlerts];
    this._queuedAlerts = [];
    this._save();
    return alerts;
  }

  // ═══════════════════════════════════════════════════════════════
  //  VOICE COMMAND DETECTION
  // ═══════════════════════════════════════════════════════════════

  /**
   * Check if a transcript matches a user state voice command.
   * Used as a fallback when the brain doesn't detect the intent.
   *
   * @param  {string} text — User transcript
   * @returns {{ match: boolean, target?: string }|null}
   */
  detectStateCommand(text) {
    if (!text) return null;
    const lower = text.toLowerCase();

    for (const { pattern, target } of USER_STATE_PATTERNS) {
      if (pattern.test(lower)) {
        return { match: true, target };
      }
    }

    return null;
  }

  /**
   * Get a confirmation message for a state transition.
   * @param {string} newState — The state transitioned to
   * @returns {string}
   */
  getConfirmation(newState) {
    const confirmations = {
      [UserStates.AVAILABLE]: [
        'Back to normal.',
        'All clear. I\'m here when you need me.',
        'Welcome back.',
      ],
      [UserStates.IN_CALL]: [
        'Got it. I\'ll hold everything until you\'re done.',
        'Going quiet. Say "I\'m back" when you\'re done.',
        'On it. Queuing alerts.',
      ],
      [UserStates.FOCUSED]: [
        'Focus mode. Only urgent alerts will come through.',
        'Heads down mode. High-priority only.',
        'Focused. I\'ll only interrupt for something critical.',
      ],
      [UserStates.DND]: [
        'Do not disturb. I\'ll log everything silently.',
        'Going dark. Say "I\'m back" when you\'re ready.',
        'Silent mode. Nothing will get through.',
      ],
    };

    const options = confirmations[newState] || ['Done.'];
    return options[Math.floor(Math.random() * options.length)];
  }
}

// ── Singleton ──────────────────────────────────────────────────────

export const userState = new UserState();
export default userState;
