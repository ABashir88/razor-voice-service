// src/intelligence/monitor.js
// Intelligence Monitor — polls Salesloft + Gmail every 2 minutes,
// detects CHANGES via delta comparison, scores signals, queues alerts.
// Integrated with SmartScheduler for work hours + meeting awareness.

import makeLogger from '../utils/logger.js';
import { salesloftPoller } from './pollers/salesloft-poller.js';
import { gmailPoller } from './pollers/gmail-poller.js';
import { signalScorer } from './signal-scorer.js';
import { alertQueue } from './alert-queue.js';
import { smartScheduler } from './smart-scheduler.js';

const log = makeLogger('Intelligence');

class IntelligenceMonitor {
  constructor() {
    this.interval = null;
    this.pollIntervalMs = 120000; // 2 minutes
    this.pollCount = 0;
    this.previousState = {
      salesloft: { opens: {}, clicks: {}, replies: {}, hot: {} },
      gmail: { messageIds: new Set() },
    };
  }

  start(googleClient = null) {
    if (googleClient) {
      smartScheduler.setGoogleClient(googleClient);
      smartScheduler.startMeetingDetection();
    }
    log.info('Starting monitor (2-minute interval, smart scheduling enabled)');
    log.info('Work hours: Mon-Fri 8am-5pm EST | Meeting detection: ' + (googleClient ? 'ON' : 'OFF'));
    this.poll();
    this.interval = setInterval(() => this.poll(), this.pollIntervalMs);
    if (this.interval.unref) this.interval.unref();
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    smartScheduler.stopMeetingDetection();
    log.info('Monitor stopped (' + this.pollCount + ' polls completed)');
  }

  async poll() {
    this.pollCount++;
    const schedule = smartScheduler.shouldDeliverAlerts();
    if (!schedule.allowed) {
      log.debug('Poll #' + this.pollCount + ' skipped: ' + schedule.reason);
      return;
    }
    log.debug('Poll #' + this.pollCount + '...');
    try {
      const slData = await salesloftPoller.poll();
      const slSignals = this.detectSalesloftChanges(slData);
      const gmData = await gmailPoller.poll();
      const gmSignals = this.detectGmailChanges(gmData);
      const allSignals = [...slSignals, ...gmSignals];
      for (const signal of allSignals) {
        const scored = signalScorer.score(signal);
        if (scored.score >= 50) {
          alertQueue.add(scored);
        }
      }
      this.updatePreviousState(slData, gmData);
      if (allSignals.length > 0) {
        log.info('Poll #' + this.pollCount + ': ' + allSignals.length + ' signals, ' + alertQueue.pending + ' queued');
      }
    } catch (err) {
      log.error('Poll error:', err.message);
    }
  }

  detectSalesloftChanges(current) {
    const signals = [];
    const prev = this.previousState.salesloft;
    for (const person of current.people || []) {
      const name = person.name;
      if (!name) continue;
      const prevOpens = prev.opens[name] || 0;
      const prevClicks = prev.clicks[name] || 0;
      const prevReplies = prev.replies[name] || 0;
      const prevHot = prev.hot[name] || false;
      if (person.replies > prevReplies) {
        signals.push({ type: 'email_reply', person: name, company: person.company, count: person.replies - prevReplies });
      }
      if (person.clicks > prevClicks) {
        signals.push({ type: 'email_click', person: name, company: person.company, count: person.clicks - prevClicks });
      }
      if (person.views > prevOpens) {
        signals.push({ type: 'email_open', person: name, company: person.company, count: person.views - prevOpens });
      }
      if (person.hot && !prevHot) {
        signals.push({ type: 'hot_lead', person: name, company: person.company });
      }
    }
    return signals;
  }

  detectGmailChanges(current) {
    const signals = [];
    const prevIds = this.previousState.gmail.messageIds;
    for (const email of current.emails || []) {
      const id = email.id || email.threadId;
      if (!id || prevIds.has(id) || prevIds.size === 0) continue;
      const fromName = extractName(email.from);
      signals.push({ type: 'new_email', person: fromName, subject: email.subject, emailId: id, from: email.from });
    }
    return signals;
  }

  updatePreviousState(slData, gmData) {
    for (const person of slData.people || []) {
      if (!person.name) continue;
      this.previousState.salesloft.opens[person.name] = person.views;
      this.previousState.salesloft.clicks[person.name] = person.clicks;
      this.previousState.salesloft.replies[person.name] = person.replies;
      this.previousState.salesloft.hot[person.name] = person.hot;
    }
    const newIds = new Set(this.previousState.gmail.messageIds);
    for (const email of gmData.emails || []) {
      const id = email.id || email.threadId;
      if (id) newIds.add(id);
    }
    this.previousState.gmail.messageIds = newIds;
  }

  getStatus() {
    const scheduleStatus = smartScheduler.getStatus();
    return {
      running: !!this.interval,
      pollCount: this.pollCount,
      intervalMs: this.pollIntervalMs,
      trackedPeople: Object.keys(this.previousState.salesloft.opens).length,
      trackedEmails: this.previousState.gmail.messageIds.size,
      pendingAlerts: alertQueue.pending,
      ...scheduleStatus,
    };
  }
}

function extractName(from) {
  if (!from) return 'Unknown';
  const match = from.match(/^"?(.+?)"?\s*<.+>/);
  if (match) return match[1].trim();
  const at = from.indexOf('@');
  return at > 0 ? from.substring(0, at) : from;
}

export const monitor = new IntelligenceMonitor();
export default monitor;
