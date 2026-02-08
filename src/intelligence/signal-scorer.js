// src/intelligence/signal-scorer.js
// Scores raw engagement signals by urgency for alert prioritization.
//
// Reply    = 100 (URGENT)
// Click    = 75  (HOT)
// 3+ Opens = 50  (WARM)
// New Email= 50  (WARM)

import makeLogger from '../utils/logger.js';

const log = makeLogger('SignalScorer');

class SignalScorer {
  /**
   * Score a single engagement signal.
   * @param {object} signal - { type, person, company, count }
   * @returns {object} Scored signal with score + urgency fields appended
   */
  score(signal) {
    let score = 0;
    let urgency = 'low';

    switch (signal.type) {
      case 'email_reply':
        score = 100;
        urgency = 'high';
        break;
      case 'email_click':
        score = 75;
        urgency = 'medium';
        break;
      case 'email_open':
        score = signal.count >= 3 ? 50 : 25;
        urgency = signal.count >= 3 ? 'medium' : 'low';
        break;
      case 'new_email':
        score = 50;
        urgency = 'medium';
        break;
      case 'hot_lead':
        score = 80;
        urgency = 'high';
        break;
      default:
        log.debug(`Unknown signal type: ${signal.type}`);
        break;
    }

    return {
      ...signal,
      score,
      urgency,
      timestamp: Date.now(),
    };
  }
}

export const signalScorer = new SignalScorer();
export default signalScorer;
