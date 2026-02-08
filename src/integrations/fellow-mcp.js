/**
 * Fellow MCP Client
 * Connects to Fellow's MCP server for meetings, notes, action items
 * Filtered to Alrazi Bashir's data only
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import makeLogger from '../utils/logger.js';

const log = makeLogger('FellowMCP');

// User filter - only return data for this user
const MY_NAME = 'Alrazi Bashir';
const MY_EMAIL = process.env.FELLOW_USER_EMAIL || 'alrazi@'; // partial match

export class FellowMCPClient {
  constructor(apiKey) {
    if (!apiKey) throw new Error('FellowMCPClient requires an API key');
    this.apiKey = apiKey;
    this.client = null;
    this.connected = false;
    this.tools = [];
  }

  async connect() {
    if (this.connected) return this.tools;

    try {
      // Fellow MCP endpoint
      const url = new URL('https://mcp.fellow.app/sse');
      url.searchParams.set('api_key', this.apiKey);

      const transport = new SSEClientTransport(url);
      this.client = new Client(
        { name: 'razor-voice', version: '1.0.0' },
        { capabilities: {} }
      );

      await this.client.connect(transport);
      this.connected = true;

      // Discover available tools
      const { tools } = await this.client.listTools();
      this.tools = tools;
      log.info(`Fellow MCP connected. Tools: ${tools.map(t => t.name).join(', ')}`);

      return this.tools;
    } catch (err) {
      log.error(`Fellow MCP connection failed: ${err.message}`);
      this.connected = false;
      throw err;
    }
  }

  async callTool(name, args = {}) {
    if (!this.connected) await this.connect();

    try {
      const result = await this.client.callTool({ name, arguments: args });
      // MCP returns content array, extract text
      if (Array.isArray(result.content)) {
        const textContent = result.content.find(c => c.type === 'text');
        if (textContent?.text) {
          try {
            return JSON.parse(textContent.text);
          } catch {
            return textContent.text;
          }
        }
      }
      return result.content;
    } catch (err) {
      log.error(`Tool ${name} failed: ${err.message}`);
      throw err;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FILTERS - Only return my data
  // ═══════════════════════════════════════════════════════════════════════════

  _isMyItem(item) {
    // Check if I'm the assignee, organizer, or owner
    const assignee = item.assignee?.name || item.assignee?.email || '';
    const organizer = item.organizer?.name || item.organizer?.email || '';
    const owner = item.owner?.name || item.owner?.email || '';
    const createdBy = item.created_by?.name || item.created_by?.email || '';
    
    const checkName = (str) => 
      str.toLowerCase().includes('alrazi') || 
      str.toLowerCase().includes('bashir') ||
      str.includes(MY_EMAIL);

    return checkName(assignee) || checkName(organizer) || checkName(owner) || checkName(createdBy);
  }

  _isMyMeeting(meeting) {
    // Check if I'm the organizer or attendee
    const organizer = meeting.organizer?.name || meeting.organizer?.email || '';
    const attendees = meeting.attendees || [];
    
    const checkName = (str) => 
      str.toLowerCase().includes('alrazi') || 
      str.toLowerCase().includes('bashir') ||
      str.includes(MY_EMAIL);

    if (checkName(organizer)) return true;
    
    for (const att of attendees) {
      const attName = att.name || att.email || '';
      if (checkName(attName)) return true;
    }
    return false;
  }

  _filterMyItems(items) {
    if (!Array.isArray(items)) return [];
    return items.filter(item => this._isMyItem(item));
  }

  _filterMyMeetings(meetings) {
    if (!Array.isArray(meetings)) return [];
    return meetings.filter(m => this._isMyMeeting(m));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ACTION ITEMS
  // ═══════════════════════════════════════════════════════════════════════════

  async getMyActionItems() {
    try {
      const items = await this.callTool('get_action_items', { status: 'open' });
      const allItems = Array.isArray(items) ? items : items?.action_items || [];
      return this._filterMyItems(allItems);
    } catch (err) {
      log.warn(`getMyActionItems failed: ${err.message}`);
      return [];
    }
  }

  async getOverdueItems() {
    try {
      const items = await this.callTool('get_action_items', { status: 'overdue' });
      const allItems = Array.isArray(items) ? items : items?.action_items || [];
      return this._filterMyItems(allItems);
    } catch (err) {
      log.warn(`getOverdueItems failed: ${err.message}`);
      return [];
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MEETINGS & NOTES
  // ═══════════════════════════════════════════════════════════════════════════

  async getTodaysMeetings() {
    try {
      const today = new Date().toISOString().split('T')[0];
      const meetings = await this.callTool('get_meetings', { date: today });
      const allMeetings = Array.isArray(meetings) ? meetings : meetings?.meetings || [];
      return this._filterMyMeetings(allMeetings);
    } catch (err) {
      log.warn(`getTodaysMeetings failed: ${err.message}`);
      return [];
    }
  }

  async getLastMeetingSummary() {
    try {
      // Get more notes and filter to find my last one
      const notes = await this.callTool('get_notes', { limit: 10 });
      const allNotes = Array.isArray(notes) ? notes : notes?.notes || [];
      const myNotes = this._filterMyMeetings(allNotes);
      if (!myNotes.length) return null;
      return myNotes[0];
    } catch (err) {
      log.warn(`getLastMeetingSummary failed: ${err.message}`);
      return null;
    }
  }

  async searchMeetingNotes(query) {
    try {
      const results = await this.callTool('search_notes', { query });
      const allNotes = Array.isArray(results) ? results : results?.notes || [];
      return this._filterMyMeetings(allNotes);
    } catch (err) {
      log.warn(`searchMeetingNotes failed: ${err.message}`);
      return [];
    }
  }

  async getRecentNotes(days = 7) {
    try {
      const notes = await this.callTool('get_notes', { days });
      const allNotes = Array.isArray(notes) ? notes : notes?.notes || [];
      return this._filterMyMeetings(allNotes);
    } catch (err) {
      log.warn(`getRecentNotes failed: ${err.message}`);
      return [];
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RECORDINGS & TRANSCRIPTS
  // ═══════════════════════════════════════════════════════════════════════════

  async getRecentRecordings(days = 7) {
    try {
      const recordings = await this.callTool('get_recordings', { days });
      const allRecs = Array.isArray(recordings) ? recordings : recordings?.recordings || [];
      return this._filterMyMeetings(allRecs);
    } catch (err) {
      log.warn(`getRecentRecordings failed: ${err.message}`);
      return [];
    }
  }

  async getLastRecording() {
    try {
      const recordings = await this.callTool('get_recordings', { limit: 10 });
      const allRecs = Array.isArray(recordings) ? recordings : recordings?.recordings || [];
      const myRecs = this._filterMyMeetings(allRecs);
      return myRecs[0] || null;
    } catch (err) {
      log.warn(`getLastRecording failed: ${err.message}`);
      return null;
    }
  }

  async getTranscriptText(recordingId) {
    try {
      const transcript = await this.callTool('get_transcript', { recording_id: recordingId });
      return transcript?.text || transcript;
    } catch (err) {
      log.warn(`getTranscriptText failed: ${err.message}`);
      return null;
    }
  }

  async getTranscriptAnalytics(recordingId) {
    try {
      const analytics = await this.callTool('get_transcript_analytics', { recording_id: recordingId });
      return analytics;
    } catch (err) {
      log.warn(`getTranscriptAnalytics failed: ${err.message}`);
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // COACHING
  // ═══════════════════════════════════════════════════════════════════════════

  async getCoachingInsights() {
    try {
      const insights = await this.callTool('get_coaching_insights', {});
      return insights;
    } catch (err) {
      log.warn(`getCoachingInsights failed: ${err.message}`);
      return null;
    }
  }

  async close() {
    if (this.client) {
      try {
        await this.client.close();
      } catch (err) {
        log.warn(`Close error: ${err.message}`);
      }
      this.connected = false;
      this.client = null;
    }
  }
}

// Factory function
export function createFellowClient(config) {
  const apiKey = config?.fellow?.apiKey || process.env.FELLOW_API_KEY;
  if (!apiKey) {
    log.info('Fellow MCP: no API key — disabled');
    return null;
  }
  return new FellowMCPClient(apiKey);
}

export default FellowMCPClient;
