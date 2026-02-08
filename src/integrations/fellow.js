// src/integrations/fellow.js
// Fellow API v1 client for Emily — Meetings, Notes, Action Items, Transcripts
//
// Fellow's API uses:
//   - Base URL: https://{subdomain}.fellow.app/api/v1/
//   - Auth header: X-API-KEY
//   - POST for list endpoints (notes, action_items, recordings)
//   - GET for single resource endpoints (note/:id, recording/:id)
//   - Cursor-based pagination: { pagination: { cursor, page_size } }

import axios from 'axios';
import makeLogger from '../utils/logger.js';
import { integrationConfig } from './config.js';

const log = makeLogger('Fellow');

// ---------------------------------------------------------------------------
// Retry helper (429, 500, 502, 503)
// ---------------------------------------------------------------------------
const RETRYABLE = new Set([429, 500, 502, 503]);
const MAX_RETRIES = 4;
const BASE_DELAY = 600;

async function withRetry(fn, label = 'fellow') {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      const status = err.response?.status;
      attempt += 1;
      if (!RETRYABLE.has(status) || attempt >= MAX_RETRIES) {
        log.error(`${label} failed (status=${status}, attempts=${attempt}): ${err.message}`);
        throw err;
      }
      const delay = BASE_DELAY * 2 ** (attempt - 1) + Math.random() * 200;
      log.warn(`Retryable ${status} on ${label}, attempt ${attempt}/${MAX_RETRIES}, backoff ${Math.round(delay)}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// ---------------------------------------------------------------------------
// FellowClient
// ---------------------------------------------------------------------------
export class FellowClient {
  constructor(apiKey, subdomain) {
    if (!apiKey) throw new Error('FellowClient requires an API key');
    if (!subdomain) throw new Error('FellowClient requires FELLOW_SUBDOMAIN');

    const baseURL = `https://${subdomain}.fellow.app/api/v1/`;
    this.http = axios.create({
      baseURL,
      headers: {
        'X-API-KEY': apiKey,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      timeout: 20_000,
    });
    this.subdomain = subdomain;
    log.info(`FellowClient initialized (subdomain=${subdomain})`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  INTERNAL HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  async _get(path, params = {}) {
    return withRetry(() => this.http.get(path, { params }), `GET ${path}`);
  }

  async _post(path, body = {}) {
    return withRetry(() => this.http.post(path, body), `POST ${path}`);
  }

  /**
   * Cursor-based pagination for Fellow POST list endpoints.
   */
  async _paginate(path, body = {}, maxPages = 10) {
    const all = [];
    let cursor = null;

    for (let i = 0; i < maxPages; i++) {
      const res = await this._post(path, {
        ...body,
        pagination: { cursor, page_size: 50 },
      });

      // Handle different response structures
      const responseData = res.data;
      const dataKey = Object.keys(responseData).find(k => k !== 'page_info');
      const container = responseData[dataKey] || responseData;
      const items = container.data ?? [];
      all.push(...items);

      cursor = container.page_info?.cursor ?? null;
      if (!cursor || items.length === 0) break;
    }
    return all;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  RECORDINGS & TRANSCRIPTS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * List all recordings (meetings with transcripts).
   * @param {object} opts - { limit?, from?, to? }
   */
  async getRecordings(opts = {}) {
    const body = {};
    if (opts.from || opts.to) {
      body.filter = {};
      if (opts.from) body.filter.created_at_start = opts.from;
      if (opts.to) body.filter.created_at_end = opts.to;
    }
    const maxPages = opts.limit ? Math.ceil(opts.limit / 50) : 5;
    const recordings = await this._paginate('recordings', body, maxPages);
    return opts.limit ? recordings.slice(0, opts.limit) : recordings;
  }

  /**
   * Get recent recordings from the last N days.
   * @param {number} days - Number of days to look back (default: 7)
   */
  async getRecentRecordings(days = 7) {
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    return this.getRecordings({ from });
  }

  /**
   * Get a single recording with full transcript.
   * @param {string} recordingId
   */
  async getRecording(recordingId) {
    const res = await this._get(`recording/${recordingId}`);
    return res.data?.recording || res.data;
  }

  /**
   * Get just the transcript segments from a recording.
   * Returns array of { speaker, text, start, end }
   */
  async getTranscript(recordingId) {
    const recording = await this.getRecording(recordingId);
    return recording?.transcript?.speech_segments || [];
  }

  /**
   * Get full transcript as plain text (speaker-labeled).
   */
  async getTranscriptText(recordingId) {
    const segments = await this.getTranscript(recordingId);
    return segments.map(s => `${s.speaker}: ${s.text}`).join('\n');
  }

  /**
   * Search recordings by meeting title.
   * @param {string} query - Search term (company name, person, topic)
   */
  async searchRecordings(query) {
    const recordings = await this.getRecordings({ limit: 50 });
    const q = query.toLowerCase();
    return recordings.filter(r => 
      r.title?.toLowerCase().includes(q)
    );
  }

  /**
   * Get the most recent recording (last call).
   */
  async getLastRecording() {
    const recordings = await this.getRecordings({ limit: 1 });
    return recordings[0] || null;
  }

  /**
   * Get transcript analytics for coaching.
   * Returns talk time ratios, speaker stats, etc.
   */
  async getTranscriptAnalytics(recordingId) {
    const segments = await this.getTranscript(recordingId);
    if (!segments.length) return null;

    const speakers = {};
    let totalDuration = 0;

    for (const seg of segments) {
      const duration = (seg.end || 0) - (seg.start || 0);
      if (!speakers[seg.speaker]) {
        speakers[seg.speaker] = { 
          name: seg.speaker, 
          talkTime: 0, 
          segments: 0,
          words: 0,
          questions: 0 
        };
      }
      speakers[seg.speaker].talkTime += duration;
      speakers[seg.speaker].segments += 1;
      speakers[seg.speaker].words += (seg.text?.split(/\s+/).length || 0);
      // Count questions
      if (seg.text?.includes('?')) {
        speakers[seg.speaker].questions += (seg.text.match(/\?/g) || []).length;
      }
      totalDuration += duration;
    }

    // Calculate percentages
    for (const speaker of Object.values(speakers)) {
      speaker.talkRatio = totalDuration > 0 
        ? Math.round((speaker.talkTime / totalDuration) * 100) 
        : 0;
    }

    return {
      totalDuration: Math.round(totalDuration),
      totalSegments: segments.length,
      speakers: Object.values(speakers),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  MEETING NOTES
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * List meeting notes.
   * @param {object} opts - { from?, to?, limit?, includeContent? }
   */
  async getNotes(opts = {}) {
    const body = {
      include: { 
        content_markdown: opts.includeContent || false, 
        event_attendees: true 
      },
    };
    if (opts.from || opts.to) {
      body.filter = {};
      if (opts.from) body.filter.created_at_start = opts.from;
      if (opts.to) body.filter.created_at_end = opts.to;
    }
    const maxPages = opts.limit ? Math.ceil(opts.limit / 50) : 5;
    const notes = await this._paginate('notes', body, maxPages);
    return opts.limit ? notes.slice(0, opts.limit) : notes;
  }

  /**
   * Get recent meeting notes from the last N days.
   */
  async getRecentNotes(days = 7) {
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    return this.getNotes({ from });
  }

  /**
   * Get a single note with full content.
   * @param {string} noteId
   */
  async getNote(noteId) {
    const res = await this._get(`note/${noteId}`);
    return res.data?.note || res.data;
  }

  /**
   * Search notes by title.
   */
  async searchNotes(query) {
    const notes = await this.getNotes({ limit: 50 });
    const q = query.toLowerCase();
    return notes.filter(n => 
      n.title?.toLowerCase().includes(q)
    );
  }

  /**
   * Get meeting notes with associated transcript (if recorded).
   */
  async getMeetingWithTranscript(noteId) {
    const note = await this.getNote(noteId);
    let transcript = null;
    let analytics = null;

    if (note?.recording_ids?.length > 0) {
      const recordingId = note.recording_ids[0];
      transcript = await this.getTranscript(recordingId);
      analytics = await this.getTranscriptAnalytics(recordingId);
    }

    return { note, transcript, analytics };
  }

  /**
   * Get today's meetings.
   */
  async getTodaysMeetings() {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    const notes = await this.getNotes({
      from: startOfDay.toISOString(),
      to: endOfDay.toISOString(),
    });

    return notes.filter(n => !n.event_is_all_day);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  ACTION ITEMS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * List action items with filters.
   * @param {object} opts - { status?, assignee?, limit?, noteId? }
   *   status: 'open' | 'completed' | 'all'
   *   assignee: 'me' | 'others' | 'all'
   */
  async getActionItems(opts = {}) {
    const filters = { archived: false };

    // Status filter — 'overdue' is handled client-side after fetch
    if (opts.status === 'completed') filters.completed = true;
    else if (opts.status !== 'all') filters.completed = false; // default: open

    // Assignee scope
    if (opts.assignee === 'me') filters.scope = 'assigned_to_me';
    else if (opts.assignee === 'others') filters.scope = 'assigned_to_others';
    else if (opts.assignee === 'all') filters.scope = 'all';
    else filters.scope = 'assigned_to_me'; // Default to my items

    // Note filter (items from specific meeting)
    if (opts.noteId) filters.note_id = opts.noteId;

    const body = {
      filters,
      order_by: 'created_at_desc',
    };

    const maxPages = opts.limit ? Math.ceil(opts.limit / 50) : 5;
    let items = await this._paginate('action_items', body, maxPages);

    // Client-side overdue filter
    if (opts.status === 'overdue') {
      const now = new Date();
      items = items.filter(item => item.due_date && new Date(item.due_date) < now);
    }

    // Sort: overdue first, then by due date (soonest first), then newest
    const now = new Date();
    items.sort((a, b) => {
      const aOverdue = a.due_date && new Date(a.due_date) < now ? 1 : 0;
      const bOverdue = b.due_date && new Date(b.due_date) < now ? 1 : 0;
      if (aOverdue !== bOverdue) return bOverdue - aOverdue;
      if (a.due_date && b.due_date) return new Date(a.due_date) - new Date(b.due_date);
      return new Date(b.created_at || 0) - new Date(a.created_at || 0);
    });

    const limit = opts.limit || 250; // default: return all (capped at pagination)
    return items.slice(0, limit);
  }

  /**
   * Get my open action items (most common query).
   */
  async getMyActionItems() {
    return this.getActionItems({ status: 'open', assignee: 'me' });
  }

  /**
   * Get action items from a specific meeting.
   */
  async getActionItemsForMeeting(noteId) {
    return this.getActionItems({ noteId, assignee: 'all' });
  }

  /**
   * Get recent action items from the last N days.
   */
  async getRecentActionItems(days = 7) {
    const items = await this.getMyActionItems();
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    return items.filter(item => new Date(item.created_at).getTime() > cutoff);
  }

  /**
   * Get overdue action items (past due date).
   */
  async getOverdueItems() {
    const items = await this.getActionItems({ status: 'open', assignee: 'me' });
    const now = new Date();
    return items.filter(item => 
      item.due_date && new Date(item.due_date) < now
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  VOICE-OPTIMIZED SUMMARY METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get a voice-friendly summary of the last meeting.
   * Designed for: "Emily, how did my last call go?"
   */
  async getLastMeetingSummary() {
    const recording = await this.getLastRecording();
    if (!recording) return { message: "I don't see any recent recorded meetings." };

    const analytics = await this.getTranscriptAnalytics(recording.id);
    const note = recording.note_id ? await this.getNote(recording.note_id) : null;
    const actionItems = note ? await this.getActionItemsForMeeting(note.id) : [];

    return {
      title: recording.title,
      date: recording.started_at,
      duration: analytics?.totalDuration || 0,
      speakers: analytics?.speakers || [],
      attendees: note?.event_attendees || [],
      actionItems: actionItems.map(i => i.text),
      recordingId: recording.id,
      noteId: note?.id,
    };
  }

  /**
   * Search for a meeting and get its summary.
   * Designed for: "Emily, what happened in my call with [company]?"
   */
  async getMeetingSummaryBySearch(query) {
    const recordings = await this.searchRecordings(query);
    if (!recordings.length) {
      return { message: `I couldn't find any meetings matching "${query}".` };
    }

    const recording = recordings[0]; // Most recent match
    return this.getMeetingSummaryById(recording.id);
  }

  /**
   * Get full meeting summary by recording ID.
   */
  async getMeetingSummaryById(recordingId) {
    const recording = await this.getRecording(recordingId);
    const analytics = await this.getTranscriptAnalytics(recordingId);
    const note = recording.note_id ? await this.getNote(recording.note_id) : null;
    const actionItems = note ? await this.getActionItemsForMeeting(note.id) : [];

    return {
      title: recording.title,
      date: recording.started_at,
      duration: analytics?.totalDuration || 0,
      speakers: analytics?.speakers || [],
      attendees: note?.event_attendees || [],
      actionItems: actionItems.map(i => i.text),
      transcript: recording.transcript?.speech_segments || [],
      recordingId: recording.id,
      noteId: note?.id,
    };
  }

  /**
   * Get coaching insights for a call.
   * Designed for: "Emily, coach me on my last call"
   */
  async getCoachingInsights(recordingId = null) {
    if (!recordingId) {
      const lastRecording = await this.getLastRecording();
      if (!lastRecording) return { message: "No recent recordings to analyze." };
      recordingId = lastRecording.id;
    }

    const recording = await this.getRecording(recordingId);
    const analytics = await this.getTranscriptAnalytics(recordingId);
    const transcript = recording.transcript?.speech_segments || [];

    if (!analytics) return { message: "Couldn't analyze this recording." };

    // Find the user (assumes user is in transcript)
    const userSpeaker = analytics.speakers.find(s => 
      s.name.toLowerCase().includes('alrazi') || 
      s.name.toLowerCase().includes('bashir')
    ) || analytics.speakers[0];

    const prospectSpeakers = analytics.speakers.filter(s => s !== userSpeaker);

    // Calculate insights
    const insights = {
      title: recording.title,
      date: recording.started_at,
      durationMinutes: Math.round(analytics.totalDuration / 60),
      
      // Talk ratio
      yourTalkRatio: userSpeaker?.talkRatio || 0,
      prospectTalkRatio: prospectSpeakers.reduce((sum, s) => sum + s.talkRatio, 0),
      
      // Questions
      questionsAsked: userSpeaker?.questions || 0,
      
      // Recommendations
      recommendations: [],
    };

    // Generate coaching recommendations
    if (insights.yourTalkRatio > 60) {
      insights.recommendations.push("You talked more than 60% of the time. Try asking more open-ended questions to let the prospect share more.");
    } else if (insights.yourTalkRatio < 30) {
      insights.recommendations.push("Great listening! You let the prospect do most of the talking.");
    } else {
      insights.recommendations.push("Good balance of talking and listening.");
    }

    if (insights.questionsAsked < 3) {
      insights.recommendations.push("Consider asking more discovery questions to better understand the prospect's needs.");
    } else if (insights.questionsAsked > 10) {
      insights.recommendations.push("You asked many questions — great discovery work!");
    }

    return insights;
  }

  /**
   * Voice-friendly action items summary.
   * Designed for: "Emily, what are my action items?"
   */
  async getActionItemsSummary() {
    const items = await this.getMyActionItems();
    
    if (!items.length) {
      return { message: "You don't have any open action items.", items: [] };
    }

    return {
      count: items.length,
      items: items.map(item => ({
        text: item.text,
        from: item.note_id, // Can be resolved to meeting title if needed
        createdAt: item.created_at,
        dueDate: item.due_date,
        aiDetected: item.ai_detected,
      })),
    };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
let _instance = null;

export function createFellowClient() {
  if (_instance) return _instance;
  const key = integrationConfig.fellow?.apiKey;
  const subdomain = integrationConfig.fellow?.subdomain;
  if (!key || !subdomain) {
    log.info('Fellow: missing API key or subdomain — client disabled');
    return null;
  }
  _instance = new FellowClient(key, subdomain);
  return _instance;
}

export default FellowClient;
