// src/intelligence/morning-briefing.js — Proactive daily morning summary
//
// At a configured time on weekdays, Razor proactively speaks a daily briefing:
//   - Calendar overview (meetings count + first meeting)
//   - Unread email count
//   - Pipeline highlights (deals closing, stale deals)
//   - Action items from Fellow
//
// The briefing is assembled from cached or fresh integration data,
// formatted for natural TTS, and spoken proactively.
//
// Usage:
//   import { morningBriefing } from './morning-briefing.js';
//   morningBriefing.start(pipeline, integrations);
//   // Or trigger manually:
//   await morningBriefing.deliver();

import EventEmitter from 'eventemitter3';
import makeLogger from '../utils/logger.js';

const log = makeLogger('MorningBriefing');

// Default: 8:30 AM on weekdays
const DEFAULT_HOUR = 8;
const DEFAULT_MINUTE = 30;

class MorningBriefing extends EventEmitter {
  constructor() {
    super();
    this._pipeline = null;
    this._integrations = null;
    this._timer = null;
    this._deliveredToday = false;
    this._lastDeliveryDate = null;
  }

  /**
   * Start the morning briefing scheduler.
   * @param {object} pipeline — Voice pipeline instance (for pipeline.speak)
   * @param {object} integrations — Integration manager instance
   * @param {object} [opts]
   * @param {number} [opts.hour=8] — Hour to deliver (24h format)
   * @param {number} [opts.minute=30] — Minute to deliver
   */
  start(pipeline, integrations, { hour = DEFAULT_HOUR, minute = DEFAULT_MINUTE } = {}) {
    this._pipeline = pipeline;
    this._integrations = integrations;

    // Check every 60s if it's briefing time
    this._timer = setInterval(() => {
      this._checkSchedule(hour, minute);
    }, 60_000);
    if (this._timer.unref) this._timer.unref();

    log.info(`Morning briefing scheduled for ${hour}:${String(minute).padStart(2, '0')} weekdays`);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  _checkSchedule(hour, minute) {
    const now = new Date();
    const day = now.getDay(); // 0=Sun, 6=Sat
    const today = now.toISOString().slice(0, 10);

    // Weekdays only
    if (day === 0 || day === 6) return;

    // Already delivered today
    if (this._lastDeliveryDate === today) return;

    // Check if within the delivery window (target minute ± 1)
    if (now.getHours() === hour && Math.abs(now.getMinutes() - minute) <= 1) {
      this._lastDeliveryDate = today;
      this.deliver().catch(err => {
        log.error('Morning briefing failed:', err.message);
      });
    }
  }

  /**
   * Assemble briefing text without speaking. Returns the text string
   * or null if nothing to report. Used by the action dispatcher.
   */
  async assemble() {
    if (!this._integrations) {
      log.warn('Morning briefing not initialized — skipping');
      return null;
    }

    log.info('Assembling morning briefing...');
    const parts = [];

    // Greeting
    const hour = new Date().getHours();
    if (hour < 12) {
      parts.push('Good morning.');
    } else {
      parts.push('Here\'s your daily briefing.');
    }

    // Calendar
    try {
      if (this._integrations.google) {
        const events = await this._integrations.google.getUpcomingEvents(1);
        if (events?.length > 0) {
          const first = events[0];
          const time = new Date(first.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
          const name = (first.summary || 'Meeting').split(/\s+/).slice(0, 3).join(' ');
          if (events.length === 1) {
            parts.push(`One meeting today, ${name} at ${time}.`);
          } else {
            parts.push(`${events.length} meetings today. First is ${name} at ${time}.`);
          }
        } else {
          parts.push('Calendar is clear today.');
        }
      }
    } catch (err) {
      log.debug('Calendar fetch failed:', err.message);
    }

    // Email
    try {
      if (this._integrations.google) {
        const emails = await this._integrations.google.getUnreadEmails(5);
        if (emails?.length > 0) {
          parts.push(`${emails.length} unread email${emails.length > 1 ? 's' : ''}.`);
        } else {
          parts.push('Inbox is clean.');
        }
      }
    } catch (err) {
      log.debug('Email fetch failed:', err.message);
    }

    // Action items
    try {
      if (this._integrations.fellow) {
        const items = await this._integrations.fellow.getMyActionItems();
        if (items?.length > 0) {
          parts.push(`${items.length} open action item${items.length > 1 ? 's' : ''} from meetings.`);
        }
      }
    } catch (err) {
      log.debug('Action items fetch failed:', err.message);
    }

    // Pipeline highlight
    try {
      if (this._integrations.salesforce) {
        const stale = await this._integrations.salesforce.getStaleDeals(7);
        if (stale?.length > 0) {
          parts.push(`${stale.length} deal${stale.length > 1 ? 's' : ''} gone quiet this week.`);
        }
      }
    } catch (err) {
      log.debug('Pipeline fetch failed:', err.message);
    }

    if (parts.length <= 1) {
      log.info('Morning briefing: nothing to report');
      return null;
    }

    const briefingText = parts.join(' ');
    log.info(`Morning briefing: "${briefingText}"`);
    this.emit('briefing:ready', briefingText);
    return briefingText;
  }

  /**
   * Deliver the morning briefing now. Can be called manually.
   * Assembles text and speaks it directly via the pipeline.
   */
  async deliver() {
    if (!this._pipeline) {
      log.warn('Morning briefing pipeline not set — skipping');
      return;
    }

    const briefingText = await this.assemble();
    if (!briefingText) return;

    try {
      await this._pipeline.speak(briefingText, { pace: 'calm', proactive: true });
    } catch (err) {
      log.error('Failed to speak morning briefing:', err.message);
    }
  }
}

// Singleton
export const morningBriefing = new MorningBriefing();
export default morningBriefing;
