// src/pipeline/follow-up-mode.js — Follow-Up Mode (via Attention System)
//
// After Razor speaks, the user can continue talking without saying "Razor".
// Previously this was a 7-second hot window. Now it delegates to the
// attention system which keeps Razor awake for 5 MINUTES after any activity.
//
// This module still handles the 500ms grace period after playback ends
// to prevent false triggers from residual speaker energy bleed.
//
// Singleton — import { followUpMode } from './follow-up-mode.js';

import { attention } from './attention.js';
import makeLogger from '../utils/logger.js';

const log = makeLogger('FollowUp');

const GRACE_PERIOD_MS = 500;

class FollowUpMode {
  constructor() {
    this._graceUntil = 0; // Ignore speech before this timestamp
  }

  /**
   * Enter follow-up mode — signals attention system and starts grace period.
   * Called after Razor finishes speaking or after barge-in.
   */
  enter() {
    this._graceUntil = Date.now() + GRACE_PERIOD_MS;
    attention.activity();
    log.info('Mode active (via attention system)');
  }

  /**
   * Exit follow-up mode — clears grace period only.
   * Does NOT kill attention — that has its own 5-minute timeout.
   */
  exit() {
    this._graceUntil = 0;
  }

  /**
   * Check if ready to accept speech (attention awake AND past grace period).
   * Use this for speech detection to avoid false triggers from speaker bleed.
   * @returns {boolean}
   */
  isReady() {
    if (!attention.checkAwake()) return false;
    // During grace period (first 500ms after playback), suppress
    if (this._graceUntil > 0 && Date.now() < this._graceUntil) return false;
    return true;
  }

  /**
   * Check if follow-up mode is active (attention awake, regardless of grace).
   * @returns {boolean}
   */
  isActive() {
    return attention.checkAwake();
  }

  /**
   * Consume follow-up — user spoke during attention window.
   * Clears grace period and refreshes attention timer.
   */
  consume() {
    this._graceUntil = 0;
    attention.activity();
    log.info('Consumed — processing follow-up command');
  }

  /**
   * Milliseconds remaining in attention window.
   * @returns {number}
   */
  remaining() {
    return attention.getTimeUntilSleep();
  }
}

// Singleton
export const followUpMode = new FollowUpMode();
export default followUpMode;
