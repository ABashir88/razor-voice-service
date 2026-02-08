// src/intelligence/smart-scheduler.js
// Smart Alert Scheduler — controls WHEN alerts can be delivered.
// - Work hours only: Mon-Fri 8am-5pm EST
// - Pauses during meetings (checks Google Calendar)
// - Configurable quiet hours

import makeLogger from '../utils/logger.js';

const log = makeLogger('SmartScheduler');

class SmartScheduler {
  constructor() {
    // Work hours config (EST)
    this.workHours = {
      start: 8,  // 8 AM
      end: 17,   // 5 PM
      days: [1, 2, 3, 4, 5], // Mon-Fri (0=Sun, 6=Sat)
      timezone: 'America/New_York',
    };
    
    // Meeting detection
    this._inMeeting = false;
    this._currentMeeting = null;
    this._calendarCheckInterval = null;
    this._googleClient = null;
  }

  /** Set Google client for calendar checks */
  setGoogleClient(client) {
    this._googleClient = client;
    if (client) {
      log.info('Google Calendar connected for meeting detection');
    }
  }

  /** Start checking calendar every 30 seconds */
  startMeetingDetection() {
    if (this._calendarCheckInterval) return;
    
    this._checkMeeting(); // Initial check
    this._calendarCheckInterval = setInterval(() => this._checkMeeting(), 30000);
    if (this._calendarCheckInterval.unref) this._calendarCheckInterval.unref();
    log.info('Meeting detection started (30s interval)');
  }

  /** Stop meeting detection */
  stopMeetingDetection() {
    if (this._calendarCheckInterval) {
      clearInterval(this._calendarCheckInterval);
      this._calendarCheckInterval = null;
    }
  }

  /** Check if currently in a meeting */
  async _checkMeeting() {
    if (!this._googleClient) {
      this._inMeeting = false;
      return;
    }

    try {
      const now = new Date();
      const events = await this._googleClient.getCalendarEvents(0); // Today only
      
      const currentMeeting = events.find(event => {
        if (!event.start || !event.end) return false;
        const start = new Date(event.start);
        const end = new Date(event.end);
        return now >= start && now <= end;
      });

      const wasInMeeting = this._inMeeting;
      this._inMeeting = !!currentMeeting;
      this._currentMeeting = currentMeeting;

      if (this._inMeeting && !wasInMeeting) {
        log.info(`Entered meeting: ${currentMeeting.summary || 'Untitled'}`);
      } else if (!this._inMeeting && wasInMeeting) {
        log.info('Meeting ended — alerts resumed');
      }
    } catch (err) {
      log.debug('Calendar check failed:', err.message);
      // Don't block alerts if calendar is unavailable
      this._inMeeting = false;
    }
  }

  /** Get current time in EST */
  _getESTTime() {
    return new Date(new Date().toLocaleString('en-US', { 
      timeZone: this.workHours.timezone 
    }));
  }

  /** Check if current time is within work hours */
  isWorkHours() {
    const now = this._getESTTime();
    const day = now.getDay();
    const hour = now.getHours();

    const isWorkDay = this.workHours.days.includes(day);
    const isWorkTime = hour >= this.workHours.start && hour < this.workHours.end;

    return isWorkDay && isWorkTime;
  }

  /** Check if in a meeting */
  isInMeeting() {
    return this._inMeeting;
  }

  /** Get current meeting info */
  getCurrentMeeting() {
    return this._currentMeeting;
  }

  /**
   * Check if alerts should be delivered right now.
   * Returns { allowed: boolean, reason?: string }
   */
  shouldDeliverAlerts() {
    // Check work hours
    if (!this.isWorkHours()) {
      const now = this._getESTTime();
      const day = now.toLocaleDateString('en-US', { weekday: 'long' });
      const time = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      return { 
        allowed: false, 
        reason: `Outside work hours (${day} ${time} EST). Alerts resume Mon-Fri 8am-5pm.`
      };
    }

    // Check meeting status
    if (this.isInMeeting()) {
      const meeting = this._currentMeeting;
      const name = meeting?.summary || 'a meeting';
      return { 
        allowed: false, 
        reason: `In ${name} — alerts paused until meeting ends.`
      };
    }

    return { allowed: true };
  }

  /** Get scheduler status */
  getStatus() {
    const now = this._getESTTime();
    return {
      currentTime: now.toLocaleString('en-US', { timeZone: this.workHours.timezone }),
      isWorkHours: this.isWorkHours(),
      isInMeeting: this.isInMeeting(),
      currentMeeting: this._currentMeeting?.summary || null,
      alertsAllowed: this.shouldDeliverAlerts().allowed,
      workHoursConfig: `Mon-Fri ${this.workHours.start}am-${this.workHours.end > 12 ? this.workHours.end - 12 + 'pm' : this.workHours.end + 'am'} EST`,
    };
  }
}

export const smartScheduler = new SmartScheduler();
export default smartScheduler;
