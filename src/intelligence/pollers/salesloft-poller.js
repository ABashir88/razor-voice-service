// src/intelligence/pollers/salesloft-poller.js
// Polls Salesloft every 60s for people with engagement (opens, clicks, replies).
// Uses the Salesloft REST v2 API via fetch. Auth from SALESLOFT_API_KEY.

import makeLogger from '../../utils/logger.js';
import { integrationConfig } from '../../integrations/config.js';

const log = makeLogger('SalesloftPoller');

const USER_ID = 89440;

class SalesloftPoller {
  constructor() {
    this.apiKey = integrationConfig.salesloft?.apiKey;
    this.userId = USER_ID;
  }

  /**
   * Poll Salesloft for all owned people with engagement counts.
   * @returns {{ people: Array<{ name, company, views, clicks, replies, hot }> }}
   */
  async poll() {
    if (!this.apiKey) {
      log.debug('No API key — skipping poll');
      return { people: [] };
    }

    log.debug('Fetching engagement data...');

    try {
      const response = await fetch(
        `https://api.salesloft.com/v2/people.json?owner_id=${this.userId}&per_page=50`,
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Accept': 'application/json',
          },
          signal: AbortSignal.timeout(15000),
        }
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();

      const people = (data.data || [])
        .filter(p =>
          (p.counts?.emails_viewed > 0) ||
          (p.counts?.emails_clicked > 0) ||
          (p.counts?.emails_replied_to > 0) ||
          p.hot_lead
        )
        .map(p => ({
          id: p.id,
          name: p.display_name,
          company: p.person_company_name,
          views: p.counts?.emails_viewed || 0,
          clicks: p.counts?.emails_clicked || 0,
          replies: p.counts?.emails_replied_to || 0,
          hot: p.hot_lead || false,
        }));

      log.debug(`${people.length} engaged people`);
      return { people };
    } catch (err) {
      log.error('Poll failed:', err.message);
      return { people: [] };
    }
  }
}

export const salesloftPoller = new SalesloftPoller();
export default salesloftPoller;
