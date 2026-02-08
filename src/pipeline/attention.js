// src/pipeline/attention.js — Attention Manager
//
// Controls how long Razor stays "awake" after an interaction.
// When awake, the user can speak commands without saying "Razor" first.
//
// Window: 5 minutes of sustained attention after any activity.
// Every command, response, or interaction resets the 5-minute timer.
// After 5 minutes of silence, Razor sleeps and requires the wake word again.
//
// This replaces the old 7-second follow-up window with a much longer
// conversational attention span — Razor stays engaged for the full
// duration of a work session.
//
// Singleton — import { attention } from './attention.js';

import { EventEmitter } from 'events';
import makeLogger from '../utils/logger.js';

const log = makeLogger('Attention');

const AWAKE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

class AttentionManager extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(20);

    this._awake = false;
    this._lastActivityAt = null;
    this._sleepTimer = null;
  }

  /**
   * Wake Razor up. Starts the 5-minute attention window.
   * Called on wake word detection and any significant interaction.
   *
   * @param {string} reason — What caused the wake ('wake_word', 'command', 'barge_in')
   */
  wake(reason = 'wake_word') {
    const wasAwake = this._awake;
    this._awake = true;
    this._lastActivityAt = Date.now();
    this._resetSleepTimer();

    if (!wasAwake) {
      log.info(`AWAKE (${reason}) — listening for 5 minutes without wake word`);
      this.emit('awake', { reason, timestamp: Date.now() });
    } else {
      log.debug(`Activity refresh (${reason}) — timer reset`);
    }
  }

  /**
   * Record activity — resets the 5-minute sleep timer.
   * Called on every command, response, barge-in, etc.
   */
  activity() {
    if (this._awake) {
      this._lastActivityAt = Date.now();
      this._resetSleepTimer();
    }
  }

  /**
   * Put Razor to sleep. Requires wake word for next interaction.
   * Called automatically after 5 minutes of silence.
   */
  sleep() {
    if (!this._awake) return;

    this._awake = false;
    this._clearSleepTimer();
    log.info('5 minutes of silence — sleeping. Say "Razor" to wake.');
    this.emit('sleep', { timestamp: Date.now() });
  }

  /**
   * Is Razor currently awake (attention active)?
   * @returns {boolean}
   */
  checkAwake() {
    return this._awake;
  }

  /**
   * Milliseconds since last activity (or Infinity if never active).
   * @returns {number}
   */
  getTimeSinceActivity() {
    if (!this._lastActivityAt) return Infinity;
    return Date.now() - this._lastActivityAt;
  }

  /**
   * Milliseconds remaining before sleep (or 0 if asleep).
   * @returns {number}
   */
  getTimeUntilSleep() {
    if (!this._awake || !this._lastActivityAt) return 0;
    const elapsed = Date.now() - this._lastActivityAt;
    return Math.max(0, AWAKE_TIMEOUT_MS - elapsed);
  }

  /**
   * Clean shutdown — clears timers.
   */
  destroy() {
    this._clearSleepTimer();
    this._awake = false;
    this.removeAllListeners();
  }

  // ── Internals ──────────────────────────────────────────────────

  _resetSleepTimer() {
    this._clearSleepTimer();
    this._sleepTimer = setTimeout(() => this.sleep(), AWAKE_TIMEOUT_MS);
    // Don't prevent process exit
    if (this._sleepTimer.unref) this._sleepTimer.unref();
  }

  _clearSleepTimer() {
    if (this._sleepTimer) {
      clearTimeout(this._sleepTimer);
      this._sleepTimer = null;
    }
  }
}

// Singleton
export const attention = new AttentionManager();
export default attention;
