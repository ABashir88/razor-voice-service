/**
 * State Machine — 10 states controlling Razor's voice behavior.
 * 
 * States: BOOT → WAITING → ACTIVE → ON_CALL / DEBRIEF / MEETING / BREAK / FOCUS / CLOSING → MONITORING
 * 
 * Each state defines:
 *   - Whether proactive speech is enabled
 *   - Whether to listen for voice input
 *   - What to do on entry
 *   - Valid transitions
 * 
 * Persists to disk so state survives restarts.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { log } from '../lib/log.js';

// ── State Definitions ──
const STATES = {
  BOOT: {
    proactive: false,
    listen: false,
    description: 'Starting up, loading memories, checking systems',
  },
  WAITING: {
    proactive: false,
    listen: true,
    description: 'Silent scan. Queueing signals. Waiting for Al.',
  },
  ACTIVE: {
    proactive: true,
    listen: true,
    description: 'Full engagement. All triggers active. Coaching. Driving.',
  },
  ON_CALL: {
    proactive: false,
    listen: false,
    description: 'Total silence. Pre-loading debrief context.',
  },
  DEBRIEF: {
    proactive: false,
    listen: true,
    description: 'Processing call outcome. MEDDPICC. Follow-up.',
  },
  MEETING: {
    proactive: false,
    listen: false,
    description: 'Silent during meeting. Monitoring for transcript after.',
  },
  BREAK: {
    proactive: false,
    listen: false,
    description: 'Al is away. Queueing everything for return.',
  },
  FOCUS: {
    proactive: false,
    listen: true,
    description: 'Respond only when spoken to. No interruptions.',
  },
  CLOSING: {
    proactive: false,
    listen: true,
    description: 'Running THINK loop. Day summary. Tomorrow preview.',
  },
  MONITORING: {
    proactive: false,
    listen: false,
    description: 'Overnight. Silent scan. Queue for morning.',
  },
};

// ── Valid Transitions ──
const TRANSITIONS = {
  BOOT:       ['WAITING'],
  WAITING:    ['ACTIVE'],
  ACTIVE:     ['ON_CALL', 'MEETING', 'BREAK', 'FOCUS', 'CLOSING', 'DEBRIEF'],
  ON_CALL:    ['DEBRIEF', 'ACTIVE'],
  DEBRIEF:    ['ACTIVE'],
  MEETING:    ['ACTIVE', 'DEBRIEF'],
  BREAK:      ['ACTIVE'],
  FOCUS:      ['ACTIVE'],
  CLOSING:    ['MONITORING'],
  MONITORING: ['WAITING', 'ACTIVE'],
};

export class StateMachine {
  constructor(persistPath) {
    this.persistPath = persistPath;
    this.current = 'BOOT';
    this.previous = null;
    this.enteredAt = Date.now();
    this.context = {};           // Working memory for current state
    this.queuedAlerts = [];      // Alerts queued during silent states
    this.listeners = [];         // State change callbacks
    this.stats = {
      callsToday: 0,
      emailsToday: 0,
      meetingsBooked: 0,
      lastCallTime: null,
      lastEmailTime: null,
      dayStarted: null,
    };
  }

  /**
   * Load persisted state from disk (survives restarts).
   */
  async load() {
    try {
      const raw = await readFile(this.persistPath, 'utf8');
      const saved = JSON.parse(raw);
      
      // Only restore if same day (reset on new day)
      const savedDate = new Date(saved.enteredAt).toDateString();
      const today = new Date().toDateString();
      
      if (savedDate === today) {
        this.current = saved.current || 'WAITING';
        this.previous = saved.previous;
        this.enteredAt = saved.enteredAt;
        this.stats = { ...this.stats, ...saved.stats };
        this.queuedAlerts = saved.queuedAlerts || [];
        log('📂', `Restored state: ${this.current}`);
      } else {
        // New day — fresh start
        this.current = 'WAITING';
        this.stats.callsToday = 0;
        this.stats.emailsToday = 0;
        this.stats.meetingsBooked = 0;
        this.stats.dayStarted = null;
        log('🌅', 'New day — state reset to WAITING');
      }
    } catch {
      // No saved state — start fresh
      this.current = 'WAITING';
    }
  }

  /**
   * Persist current state to disk.
   */
  async save() {
    try {
      await mkdir(dirname(this.persistPath), { recursive: true });
      await writeFile(this.persistPath, JSON.stringify({
        current: this.current,
        previous: this.previous,
        enteredAt: this.enteredAt,
        stats: this.stats,
        queuedAlerts: this.queuedAlerts.slice(-20), // Keep last 20
      }, null, 2));
    } catch {}
  }

  /**
   * Transition to a new state.
   */
  async transition(newState, context = {}) {
    const upper = newState.toUpperCase();
    
    if (!STATES[upper]) {
      log('⚠️', `Unknown state: ${newState}`);
      return false;
    }

    // AI controls transitions — allow any valid state
    if (upper === this.current) return true; // Already in this state

    this.previous = this.current;
    this.current = upper;
    this.enteredAt = Date.now();
    this.context = context;

    log('🔄', `State: ${this.previous} → ${this.current}`);

    // Notify listeners
    for (const listener of this.listeners) {
      try {
        await listener(this.current, this.previous, context);
      } catch (err) {
        log('⚠️', `State listener error: ${err.message}`);
      }
    }

    await this.save();
    return true;
  }

  /**
   * Register a state change listener.
   */
  onChange(callback) {
    this.listeners.push(callback);
  }

  /**
   * Queue an alert for when Al returns to an active listening state.
   */
  queueAlert(alert) {
    this.queuedAlerts.push({
      ...alert,
      queuedAt: Date.now(),
    });
    // Cap at 50
    if (this.queuedAlerts.length > 50) {
      this.queuedAlerts = this.queuedAlerts.slice(-50);
    }
  }

  /**
   * Drain queued alerts (call when returning to ACTIVE).
   */
  drainAlerts() {
    const alerts = [...this.queuedAlerts];
    this.queuedAlerts = [];
    return alerts;
  }

  /**
   * Record a call for daily tracking.
   */
  logCall() {
    this.stats.callsToday++;
    this.stats.lastCallTime = Date.now();
    this.save();
  }

  /**
   * Record an email for daily tracking.
   */
  logEmail() {
    this.stats.emailsToday++;
    this.stats.lastEmailTime = Date.now();
    this.save();
  }

  /**
   * Record a meeting booked.
   */
  logMeeting() {
    this.stats.meetingsBooked++;
    this.save();
  }

  /**
   * Check if proactive speech is allowed in current state.
   */
  get canSpeak() {
    return STATES[this.current]?.proactive ?? false;
  }

  /**
   * Check if we should listen for voice input.
   */
  get canListen() {
    return STATES[this.current]?.listen ?? false;
  }

  /**
   * Minutes in current state.
   */
  get minutesInState() {
    return Math.floor((Date.now() - this.enteredAt) / 60000);
  }

  /**
   * Get full status for API.
   */
  getStatus() {
    return {
      state: this.current,
      previous: this.previous,
      minutesInState: this.minutesInState,
      canSpeak: this.canSpeak,
      canListen: this.canListen,
      queuedAlerts: this.queuedAlerts.length,
      stats: { ...this.stats },
      description: STATES[this.current]?.description,
    };
  }

}

export { STATES };
