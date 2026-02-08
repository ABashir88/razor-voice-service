// src/integrations/google.js
// Gmail + Google Calendar client for Razor — uses gog CLI (pre-authenticated).
//
// The gog CLI (https://github.com/mxk/gog) is already authenticated via
// GOG_ACCOUNT. All methods shell out to gog with --json --no-input for
// machine-readable output.

import { execFile } from 'child_process';
import { promisify } from 'util';
import makeLogger from '../utils/logger.js';
import { integrationConfig } from './config.js';

const execFileAsync = promisify(execFile);
const log = makeLogger('Google');

const MAX_RETRIES = 3;
const BASE_DELAY = 500;

// ---------------------------------------------------------------------------
// Run a gog command with retry on transient failures
// ---------------------------------------------------------------------------
async function gog(args, label = 'gog') {
  let attempt = 0;
  while (true) {
    try {
      log.debug(`${label}: gog ${args.join(' ')}`);
      const { stdout } = await execFileAsync('gog', args, {
        timeout: 30000,
        maxBuffer: 5 * 1024 * 1024,
      });
      return stdout;
    } catch (err) {
      attempt++;
      // Retry on transient errors (timeout, signal, etc.) but not on usage errors
      const isTransient = err.killed || err.signal || /timeout|ETIMEDOUT|ECONNRESET/i.test(err.message);
      if (!isTransient || attempt >= MAX_RETRIES) {
        const stderr = err.stderr?.trim() || err.message;
        log.error(`${label} failed (attempt ${attempt}): ${stderr}`);
        throw new Error(`${label}: ${stderr}`);
      }
      const delay = BASE_DELAY * 2 ** (attempt - 1);
      log.warn(`${label} transient error, retry ${attempt}/${MAX_RETRIES} in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// ---------------------------------------------------------------------------
// GoogleClient — gog CLI wrapper
// ---------------------------------------------------------------------------
export class GoogleClient {
  /**
   * @param {object} cfg
   * @param {string} cfg.gogAccount — email for --account flag
   * @param {string} [cfg.gogKeyringPassword] — optional keyring password
   */
  constructor(cfg) {
    if (!cfg.gogAccount) {
      throw new Error('GoogleClient requires GOG_ACCOUNT');
    }
    this.account = cfg.gogAccount;

    // If a keyring password is set, gog reads it from GOG_KEYRING_PASSWORD env
    // We ensure it's in process.env for child processes
    if (cfg.gogKeyringPassword) {
      process.env.GOG_KEYRING_PASSWORD = cfg.gogKeyringPassword;
    }

    log.info(`GoogleClient initialised (gog CLI, account=${this.account})`);
  }

  /** Common args prepended to every gog call */
  _base() {
    return ['--account', this.account, '--json', '--no-input'];
  }

  // =========================================================================
  // GMAIL
  // =========================================================================

  /**
   * Send an email.
   * @param {object} opts - { to, subject, body, cc?, bcc? }
   */
  async sendEmail(opts) {
    const args = ['gmail', 'send', ...this._base(),
      '--to', opts.to,
      '--subject', opts.subject || '(no subject)',
      '--body', opts.body || '',
    ];
    if (opts.cc)  args.push('--cc', opts.cc);
    if (opts.bcc) args.push('--bcc', opts.bcc);

    const out = await gog(args, 'gmail.send');
    const data = JSON.parse(out);
    log.info(`Email sent — id=${data.id || '(sent)'}`);
    return data;
  }

  /**
   * Draft an email (does not send).
   * @param {object} opts - { to, subject, body, cc?, bcc? }
   */
  async draftEmail(opts) {
    const args = ['gmail', 'drafts', 'create', ...this._base(),
      '--to', opts.to || '',
      '--subject', opts.subject || '(no subject)',
      '--body', opts.body || '',
    ];
    if (opts.cc)  args.push('--cc', opts.cc);
    if (opts.bcc) args.push('--bcc', opts.bcc);

    const out = await gog(args, 'gmail.draft');
    const data = JSON.parse(out);
    log.info(`Draft created — id=${data.id || '(created)'}`);
    return data;
  }

  /**
   * Search for recent emails.
   * @param {string} query — Gmail search query (e.g. "from:alice subject:deal")
   * @param {number} [max=10]
   */
  async getRecentEmails(query = '', max = 10) {
    try {
      const args = ['gmail', 'search', ...this._base(),
        '--max', String(max),
        query,
      ];

      const out = await gog(args, 'gmail.search');
      const threads = JSON.parse(out);

      // gog search --json returns an array of thread objects
      // Normalise to match the shape the rest of Razor expects
      if (!Array.isArray(threads)) return [];
      return threads.map((t) => ({
        id:       t.id || t.threadId || '',
        threadId: t.threadId || t.id || '',
        from:     t.from || t.sender || '',
        to:       t.to || '',
        subject:  t.subject || '',
        date:     t.date || t.lastMessageDate || '',
        snippet:  t.snippet || '',
      }));
    } catch (error) {
      log.error('[Google] getRecentEmails error:', error.message);
      throw error;
    }
  }

  /**
   * Get new inbox emails from the last 24 hours.
   * @param {number} [limit=5]
   */
  async getNewEmails(limit = 5) {
    return this.getRecentEmails('is:inbox newer_than:1d', limit);
  }

  /**
   * Get unread emails.
   * @param {number} [limit=10]
   */
  async getUnreadEmails(limit = 10) {
    return this.getRecentEmails('is:unread', limit);
  }

  /**
   * Search emails with a custom query.
   * @param {string} query — Gmail search query
   * @param {number} [limit=5]
   */
  async searchEmails(query, limit = 5) {
    return this.getRecentEmails(query || '', limit);
  }

  /**
   * Get a full email thread by ID.
   */
  async getEmailThread(threadId) {
    const args = ['gmail', 'thread', 'get', ...this._base(), threadId];

    const out = await gog(args, 'gmail.thread');
    const data = JSON.parse(out);

    // Normalise
    const messages = Array.isArray(data.messages) ? data.messages : (Array.isArray(data) ? data : []);
    return {
      id: threadId,
      messages: messages.map((m) => ({
        id:       m.id || '',
        threadId: m.threadId || threadId,
        from:     m.from || '',
        to:       m.to || '',
        subject:  m.subject || '',
        date:     m.date || '',
        snippet:  m.snippet || m.body?.slice(0, 200) || '',
      })),
    };
  }

  // =========================================================================
  // CALENDAR
  // =========================================================================

  /**
   * Get upcoming events for the next N days.
   */
  async getUpcomingEvents(days = 7) {
    try {
      const from = new Date().toISOString();
      const to = new Date(Date.now() + days * 86_400_000).toISOString();

      log.debug(`Fetching calendar from ${from} to ${to}`);

      const args = ['calendar', 'events', 'primary', ...this._base(),
        '--from', from,
        '--to', to,
        '--max', '50',
      ];

      const out = await gog(args, 'calendar.events');
      const data = JSON.parse(out);

      // gog CLI can return multiple shapes:
      //   - bare array: [ev, ev, ...]
      //   - nested array: [[ev, ev, ...]]
      //   - object with items: { items: [...] }
      //   - object with events: { events: [...] }
      //   - object with data: { data: [...] }
      let events;
      if (Array.isArray(data)) {
        // Unwrap nested array if gog wraps in [[...]]
        events = (data.length === 1 && Array.isArray(data[0])) ? data[0] : data;
      } else {
        events = data.items || data.events || data.data || [];
      }

      log.debug(`Raw calendar events: ${events.length} found`);

      const normalised = events.map(this._normaliseEvent);
      return normalised;
    } catch (error) {
      log.error('[Google] getUpcomingEvents error:', error.message);
      throw error;
    }
  }

  /**
   * Get a single event by ID.
   */
  async getEvent(id) {
    const args = ['calendar', 'event', 'primary', id, ...this._base()];

    const out = await gog(args, 'calendar.get');
    const ev = JSON.parse(out);
    return this._normaliseEvent(ev);
  }

  /**
   * Create a calendar event.
   * @param {object} opts - { summary, start, end, attendees?, description?, location? }
   */
  async createEvent(opts) {
    const startIso = opts.start instanceof Date ? opts.start.toISOString() : opts.start;
    const endIso = opts.end instanceof Date ? opts.end.toISOString() : opts.end;

    const args = ['calendar', 'create', 'primary', ...this._base(),
      '--summary', opts.summary || 'Meeting',
      '--from', startIso,
    ];
    if (endIso) args.push('--to', endIso);
    if (opts.description) args.push('--description', opts.description);
    if (opts.location) args.push('--location', opts.location);
    if (opts.attendees?.length) {
      const emails = opts.attendees.map((a) => typeof a === 'string' ? a : a.email);
      args.push('--attendees', emails.join(','));
    }

    const out = await gog(args, 'calendar.create');
    const ev = JSON.parse(out);
    log.info(`Event created — id=${ev.id || '(created)'}`);
    return this._normaliseEvent(ev);
  }

  /**
   * Find free slots between start and end for a meeting of durationMin minutes.
   * @returns {Array<{ start: string, end: string }>}
   */
  async findFreeSlots(start, end, durationMin = 30) {
    const fromIso = new Date(start).toISOString();
    const toIso = new Date(end).toISOString();

    const args = ['calendar', 'freebusy', 'primary', ...this._base(),
      '--from', fromIso,
      '--to', toIso,
    ];

    const out = await gog(args, 'calendar.freebusy');
    const data = JSON.parse(out);

    // gog freebusy --json returns busy intervals; compute gaps
    const busySlots = Array.isArray(data) ? data : (data.busy || data.calendars?.primary?.busy || []);
    return this._computeFreeSlots(new Date(start), new Date(end), busySlots, durationMin);
  }

  // ---- Calendar helpers ---------------------------------------------------

  _normaliseEvent(ev) {
    // gog CLI uses different property names depending on version/format.
    // Handle Google Calendar API shape AND gog CLI shape.
    const startRaw = ev.start?.dateTime || ev.start?.date || ev.startTime || ev.start || null;
    const endRaw   = ev.end?.dateTime   || ev.end?.date   || ev.endTime   || ev.end   || null;

    return {
      id:          ev.id || ev.eventId || '',
      summary:     ev.summary || ev.title || ev.subject || '',
      description: ev.description || ev.notes || '',
      location:    ev.location || '',
      start:       startRaw,
      end:         endRaw,
      attendees:   (ev.attendees || ev.participants || []).map((a) => ({
        email:  a.email || a.emailAddress || '',
        name:   a.displayName || a.name || '',
        status: a.responseStatus || a.status || '',
      })),
      htmlLink:    ev.htmlLink || ev.link || '',
      status:      ev.status || ev.eventStatus || '',
    };
  }

  _computeFreeSlots(rangeStart, rangeEnd, busySlots, durationMin) {
    const durMs = durationMin * 60_000;
    const slots = [];

    const sorted = busySlots
      .map((b) => ({ s: new Date(b.start), e: new Date(b.end) }))
      .sort((a, b) => a.s - b.s);

    let cursor = rangeStart;
    for (const b of sorted) {
      if (b.s - cursor >= durMs) {
        slots.push({ start: cursor.toISOString(), end: b.s.toISOString() });
      }
      if (b.e > cursor) cursor = b.e;
    }
    if (rangeEnd - cursor >= durMs) {
      slots.push({ start: cursor.toISOString(), end: rangeEnd.toISOString() });
    }
    return slots;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
let _instance = null;

export function createGoogleClient() {
  if (_instance) return _instance;
  const c = integrationConfig.google;
  if (!c?.gogAccount) {
    log.info('Google: GOG_ACCOUNT not set — client disabled');
    return null;
  }
  _instance = new GoogleClient(c);
  return _instance;
}

export default GoogleClient;
