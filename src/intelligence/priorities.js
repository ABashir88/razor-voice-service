// src/intelligence/priorities.js — Composite priority engine
//
// Combines calendar, action items, and hot leads into a single
// spoken priority summary. Used when user asks "what should I be doing?"
//
// Usage:
//   import { priorityEngine } from './priorities.js';
//   priorityEngine.init(integrations);
//   const summary = await priorityEngine.getPriorities();

import makeLogger from '../utils/logger.js';

const log = makeLogger('Priorities');

class PriorityEngine {
  constructor() {
    this._integrations = null;
  }

  init(integrations) {
    this._integrations = integrations;
  }

  /**
   * Fetch calendar + action items + hot leads in parallel,
   * then compose a concise spoken priority summary.
   * @returns {string} — voice-ready priority text (under 30 words target)
   */
  async getPriorities() {
    if (!this._integrations) {
      log.warn('PriorityEngine not initialized');
      return 'Priority engine not ready.';
    }

    const [calResult, itemsResult, leadsResult] = await Promise.allSettled([
      this._getCalendar(),
      this._getActionItems(),
      this._getHotLeads(),
    ]);

    const parts = [];

    // Calendar — what's coming up
    const cal = calResult.status === 'fulfilled' ? calResult.value : null;
    if (cal) {
      const events = cal.calendarEvents || cal.events || (Array.isArray(cal) ? cal : null);
      if (events?.length > 0) {
        const first = events[0];
        const time = first.start
          ? new Date(first.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
          : '';
        const name = (first.summary || 'meeting').split(/\s+/).slice(0, 3).join(' ');
        parts.push(`Next up, ${name}${time ? ' at ' + time : ''}`);
      } else {
        parts.push("Calendar's clear");
      }
    }

    // Action items — overdue or due today
    const items = itemsResult.status === 'fulfilled' ? itemsResult.value : null;
    if (items?.length > 0) {
      const now = new Date();
      const overdueCount = items.filter(i => i.due_date && new Date(i.due_date) < now).length;
      if (overdueCount > 0) {
        const first = items.find(i => i.due_date && new Date(i.due_date) < now);
        const title = (first?.title || first?.text || '').slice(0, 40);
        parts.push(`${overdueCount} overdue item${overdueCount > 1 ? 's' : ''}${title ? ', top one is ' + title : ''}`);
      } else {
        parts.push(`${items.length} open items, none overdue`);
      }
    }

    // Hot leads — who needs attention
    const leads = leadsResult.status === 'fulfilled' ? leadsResult.value : null;
    if (leads?.length > 0) {
      const topNames = leads.slice(0, 2).map(l => l.name || l.email || 'unknown').join(' and ');
      parts.push(`${leads.length} hot lead${leads.length > 1 ? 's' : ''}, ${topNames}`);
    }

    if (parts.length === 0) {
      return "All clear right now. No meetings, no overdue items, no hot leads.";
    }

    return parts.join('. ') + '.';
  }

  async _getCalendar() {
    try {
      if (this._integrations.google) {
        return await this._integrations.getUpcomingSchedule(1);
      }
    } catch (err) {
      log.debug('Priority calendar fetch failed:', err.message);
    }
    return null;
  }

  async _getActionItems() {
    try {
      if (this._integrations.fellow) {
        return await this._integrations.fellow.getActionItems({ limit: 5, status: 'open', assignee: 'me' });
      }
    } catch (err) {
      log.debug('Priority action items fetch failed:', err.message);
    }
    return null;
  }

  async _getHotLeads() {
    try {
      if (this._integrations.salesloft) {
        return await this._integrations.salesloft.getHotLeads();
      }
    } catch (err) {
      log.debug('Priority hot leads fetch failed:', err.message);
    }
    return null;
  }
}

// Singleton
export const priorityEngine = new PriorityEngine();
export default priorityEngine;
