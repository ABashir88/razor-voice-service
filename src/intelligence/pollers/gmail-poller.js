// src/intelligence/pollers/gmail-poller.js
// Polls Gmail every 60s for new inbound emails from real contacts.
// Uses the GoogleClient from integrations (gog CLI).

import makeLogger from '../../utils/logger.js';
import { createGoogleClient } from '../../integrations/google.js';

const log = makeLogger('GmailPoller');

const NOISE_PATTERNS = [
  'no-reply', 'noreply', 'notifications', 'mailer-daemon',
  'fellow.app', 'slack.com', 'salesforce.com', 'salesloft.com',
  'marketo', 'hubspot', 'google.com', 'calendar-notification',
];

class GmailPoller {
  constructor() {
    this.client = createGoogleClient();
  }

  /**
   * Poll Gmail for recent inbound emails.
   * @returns {{ emails: Array<{ id, from, subject, snippet }> }}
   */
  async poll() {
    if (!this.client) {
      log.debug('No Google client — skipping poll');
      return { emails: [] };
    }

    log.debug('Checking inbox...');

    try {
      const query = 'to:alrazi@telnyx.com category:primary newer_than:2m';
      const raw = await this.client.getRecentEmails(query, 10);

      // Filter out noise
      const emails = (raw || []).filter(e => !isNoise(e.from));

      if (emails.length > 0) {
        log.debug(`${emails.length} new emails`);
      }

      return { emails };
    } catch (err) {
      // Gmail checks are best-effort — suppress timeout noise
      if (!err.message?.includes('timeout') && !err.message?.includes('No messages')) {
        log.error('Poll failed:', err.message);
      }
      return { emails: [] };
    }
  }
}

function isNoise(from) {
  if (!from) return true;
  const lower = from.toLowerCase();
  return NOISE_PATTERNS.some(p => lower.includes(p));
}

export const gmailPoller = new GmailPoller();
export default gmailPoller;
