// src/intelligence/alert-queue.js
// Queues scored signals and delivers them based on user state.
// Deduplicates by person + type + hour window.
// Formats alerts as natural spoken phrases.

import makeLogger from '../utils/logger.js';

const log = makeLogger('AlertQueue');

class AlertQueue {
  constructor() {
    this.queue = [];
    this.delivered = new Set();
  }

  /**
   * Add a scored signal to the queue.
   * Skips duplicates within the same hour window.
   * @param {object} signal - Scored signal from SignalScorer
   */
  add(signal) {
    const key = `${signal.person}-${signal.type}-${Math.floor(Date.now() / 3600000)}`;
    if (this.delivered.has(key)) {
      log.debug(`Skipping duplicate: ${key}`);
      return;
    }

    this.queue.push(signal);
    this.queue.sort((a, b) => b.score - a.score);
    log.info(`Added: ${signal.type} from ${signal.person} (score: ${signal.score})`);
  }

  /** Get and remove the highest-priority alert. */
  getNext() {
    return this.queue.shift();
  }

  /** Peek at the highest-priority alert without removing. */
  peek() {
    return this.queue[0];
  }

  /** Check if there are pending alerts. */
  hasAlerts() {
    return this.queue.length > 0;
  }

  /** Number of pending alerts. */
  get pending() {
    return this.queue.length;
  }

  /**
   * Mark a signal as delivered (prevents re-alerting within the hour).
   * @param {object} signal
   */
  markDelivered(signal) {
    const key = `${signal.person}-${signal.type}-${Math.floor(Date.now() / 3600000)}`;
    this.delivered.add(key);
  }

  /**
   * Format a scored signal as a natural spoken alert.
   * @param {object} signal - { type, person, company, count, score }
   * @returns {string} Spoken alert text
   */
  formatAlert(signal) {
    const firstName = (signal.person || 'Someone').split(' ')[0];
    const company = signal.company ? ` at ${signal.company}` : '';

    switch (signal.type) {
      case 'email_reply':
        return `Heads up — ${firstName}${company} just replied to your email.`;
      case 'email_click':
        return `${firstName}${company} clicked your link${signal.count > 1 ? ` ${signal.count} times` : ''}. Hot lead.`;
      case 'email_open':
        return `${firstName}${company} opened your email${signal.count > 1 ? ` ${signal.count} times` : ''}.`;
      case 'new_email':
        return `New email from ${firstName}${company}.${signal.subject ? ` Subject: ${signal.subject}.` : ''}`;
      case 'hot_lead':
        return `${firstName}${company} just became a hot lead.`;
      default:
        return `Activity from ${firstName}${company}.`;
    }
  }
}

export const alertQueue = new AlertQueue();
export default alertQueue;
