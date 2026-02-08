// src/brain/connector.js — WebSocket client to the Razor Brain (Python) server
//
// Connects to ws://localhost:8780/ws, sends user transcripts, receives
// AI responses with intent, entities, actions, and follow-ups.
// Auto-reconnects with exponential backoff.

import WebSocket from 'ws';
import EventEmitter from 'eventemitter3';
import makeLogger from '../utils/logger.js';

const log = makeLogger('BrainConnector');

const DEFAULT_URI = 'ws://127.0.0.1:8780/ws';
const MAX_RECONNECT_ATTEMPTS = 20;
const BASE_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30000;
const HEARTBEAT_INTERVAL = 25000;
const RESPONSE_TIMEOUT = 60000;
const BRAIN_TIMEOUT_MS = 4000; // 4 seconds — enough for most brain responses

export class BrainConnector extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {string} [opts.uri] — Brain server WebSocket URI
   * @param {number} [opts.responseTimeout] — Max ms to wait for a brain response
   */
  constructor(opts = {}) {
    super();
    this.uri = opts.uri || process.env.BRAIN_WS_URI || DEFAULT_URI;
    this.responseTimeout = opts.responseTimeout || RESPONSE_TIMEOUT;
    this._ws = null;
    this._reconnectAttempt = 0;
    this._reconnectTimer = null;
    this._heartbeatTimer = null;
    this._pendingRequests = new Map(); // requestId → { resolve, reject, timer }
    this._requestCounter = 0;
    this._connected = false;
    this._shutdown = false;
  }

  /** True when the WebSocket is open and healthy. */
  get connected() {
    return this._connected && this._ws?.readyState === WebSocket.OPEN;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /** Connect to the brain server. Returns when connected (or throws after retries). */
  async connect() {
    this._shutdown = false;
    return new Promise((resolve, reject) => {
      this._connect(resolve, reject);
    });
  }

  /** Gracefully disconnect. */
  async disconnect() {
    this._shutdown = true;
    clearTimeout(this._reconnectTimer);
    clearInterval(this._heartbeatTimer);

    // Reject all pending requests
    for (const [id, pending] of this._pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Brain connector shutting down'));
    }
    this._pendingRequests.clear();

    if (this._ws) {
      this._ws.removeAllListeners();
      if (this._ws.readyState === WebSocket.OPEN) {
        this._ws.close(1000, 'shutdown');
      }
      this._ws = null;
    }
    this._connected = false;
    log.info('Disconnected from brain server');
  }

  // ── Send a transcript and wait for the full response ────────────────────

  /**
   * Process a user utterance through the brain with a fast timeout.
   * If the brain doesn't respond within BRAIN_TIMEOUT_MS, returns a
   * fallback response with inferred actions so the pipeline keeps moving.
   *
   * @param {string} text — User transcript
   * @param {object} [metadata] — Optional context (audio confidence, etc.)
   * @param {boolean} [stream=false] — If true, stream chunks via events
   * @returns {Promise<object>} — Brain response: { text, intent, state, actions, entities, follow_up, latency_ms }
   */
  async process(text, metadata = {}, stream = false) {
    const startTime = Date.now();

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Brain timeout')), BRAIN_TIMEOUT_MS)
    );

    try {
      const response = await Promise.race([
        this._actualProcess(text, metadata, stream),
        timeoutPromise,
      ]);

      const elapsed = Date.now() - startTime;
      if (elapsed > 1000) {
        log.warn(`Slow brain response: ${elapsed}ms`);
      }

      return response;
    } catch (err) {
      const elapsed = Date.now() - startTime;
      log.warn(`Brain timeout or error after ${elapsed}ms: ${err.message}`);

      const actions = this._inferActionsFromMessage(text);

      if (actions.length > 0) {
        // We inferred actions — proceed with them silently
        return {
          type: 'response',
          request_id: `fallback_${Date.now()}`,
          text: '.',
          intent: 'fallback',
          actions,
          entities: [],
          state: 'listening',
          follow_up: '',
          latency_ms: elapsed,
        };
      }

      // No actions inferred — ask for clarification
      return {
        type: 'response',
        request_id: `fallback_${Date.now()}`,
        text: "I didn't catch that. Can you be more specific?",
        intent: 'clarify',
        actions: [],
        entities: [],
        state: 'listening',
        follow_up: '',
        latency_ms: elapsed,
      };
    }
  }

  /**
   * Infer likely actions from the user's message when the brain times out.
   * This is a last-resort safety net — the brain handles 95% of cases.
   * Ordered from most specific to least specific to avoid false matches.
   * @param {string} message — Raw user transcript
   * @returns {Array<object>} — Inferred action list (may be empty)
   */
  _inferActionsFromMessage(message) {
    const lower = message.toLowerCase();

    // ── Pipeline / Deals (most specific first) ──
    if (lower.includes('biggest deal') || lower.includes('largest deal')) {
      return [{ action: 'get_biggest_deal', params: {} }];
    }
    if (lower.includes('stale') || lower.includes('stuck') || lower.includes('cold')) {
      return [{ action: 'get_stale_deals', params: {} }];
    }
    if (lower.includes('closing this week')) {
      return [{ action: 'get_deals_closing_soon', params: { days: 7 } }];
    }
    if (lower.includes('closing this month') || lower.includes('closing soon')) {
      return [{ action: 'get_deals_closing_soon', params: { days: 30 } }];
    }
    if (lower.includes('deal') && (lower.includes('tell me') || lower.includes('about'))) {
      const match = lower.match(/(?:about|the)\s+(.+?)\s*deal/);
      const dealName = match ? match[1] : lower.replace(/.*deal\s*/, '').trim();
      return [{ action: 'get_deal_by_name', params: { name: dealName } }];
    }
    if (lower.includes('pipeline') || lower.includes('how much')) {
      return [{ action: 'get_pipeline', params: {} }];
    }
    if (lower.includes('task') || lower.includes('to-do') || lower.includes('to do')) {
      return [{ action: 'get_tasks', params: {} }];
    }

    // ── Salesloft / Leads (specific engagement before broad) ──
    if (lower.includes('click') || lower.includes('clicked')) {
      return [{ action: 'get_email_clicks', params: {} }];
    }
    if (lower.includes('open') && lower.includes('email')) {
      return [{ action: 'get_email_opens', params: {} }];
    }
    if (lower.includes('repl')) {
      return [{ action: 'get_replies', params: {} }];
    }
    if (lower.includes('hot lead') || lower.includes('hot leads')) {
      return [{ action: 'get_hot_leads', params: {} }];
    }
    if (lower.includes('showing interest') || lower.includes('engaged') || lower.includes('engagement')) {
      return [{ action: 'get_hot_leads', params: {} }];
    }
    if (lower.includes('cadence')) {
      return [{ action: 'get_my_cadences', params: {} }];
    }
    if (lower.includes('outreach') || lower.includes('activity')) {
      return [{ action: 'get_activity_stats', params: {} }];
    }
    if (lower.includes('look up') || lower.includes('lookup')) {
      const name = lower.replace(/.*look\s*up\s*/, '').replace(/[?.!]/g, '').trim();
      return [{ action: 'lookup_contact', params: { name } }];
    }

    // ── Calendar ──
    if (lower.includes('calendar') || lower.includes('meeting') || lower.includes('schedule')) {
      let days = 1;
      if (lower.includes('week')) days = 7;
      if (lower.includes('tomorrow')) days = 2;
      if (lower.includes('monday') || lower.includes('tuesday') || lower.includes('wednesday') ||
          lower.includes('thursday') || lower.includes('friday')) days = 7;
      return [{ action: 'check_calendar', params: { days } }];
    }

    // ── Email (after clicks/opens so those match first) ──
    if (lower.includes('email') || lower.includes('inbox') || lower.includes('mail')) {
      if (lower.includes('from')) {
        const from = lower.replace(/.*from\s*/, '').replace(/[?.!]/g, '').trim();
        return [{ action: 'search_emails', params: { query: `from:${from}` } }];
      }
      return [{ action: 'get_new_emails', params: {} }];
    }

    // ── Follow-ups ──
    if (lower.includes('tell me more') || lower.includes('more detail')) {
      return [{ action: 'tell_me_more', params: {} }];
    }

    // Default — return empty, don't guess
    return [];
  }

  /**
   * Send to the brain WebSocket and wait for the full response.
   * @param {string} text — User transcript
   * @param {object} [metadata] — Optional context
   * @param {boolean} [stream=false] — Stream chunks via events
   * @returns {Promise<object>} — Raw brain response
   */
  async _actualProcess(text, metadata = {}, stream = false) {
    if (!this.connected) {
      throw new Error('Brain connector not connected');
    }

    const requestId = `req_${++this._requestCounter}_${Date.now()}`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingRequests.delete(requestId);
        reject(new Error(`Brain response timeout (${this.responseTimeout}ms)`));
      }, this.responseTimeout);

      this._pendingRequests.set(requestId, { resolve, reject, timer, stream });

      const message = JSON.stringify({
        text,
        metadata,
        stream,
        request_id: requestId,
      });

      this._ws.send(message, (err) => {
        if (err) {
          this._pendingRequests.delete(requestId);
          clearTimeout(timer);
          reject(err);
        }
      });

      log.debug(`Sent to brain [${requestId}]: "${text.slice(0, 80)}"`);
    });
  }

  /**
   * Request a new session from the brain.
   * @returns {Promise<string>} — New session ID
   */
  async newSession() {
    try {
      const res = await fetch(`http://${this.uri.replace('ws://', '').replace('/ws', '')}/session/new`, {
        method: 'POST',
      });
      const data = await res.json();
      log.info(`New brain session: ${data.session_id}`);
      return data.session_id;
    } catch (err) {
      log.error('Failed to create new session:', err.message);
      return null;
    }
  }

  /**
   * Get brain health status.
   * @returns {Promise<object|null>}
   */
  async health() {
    try {
      const host = this.uri.replace('ws://', '').replace('/ws', '');
      const res = await fetch(`http://${host}/health`);
      return await res.json();
    } catch (err) {
      return null;
    }
  }

  // ── Internal: connection management ─────────────────────────────────────

  _connect(onFirstConnect, onFirstFail) {
    if (this._shutdown) return;

    log.info(`Connecting to brain at ${this.uri}...`);

    const ws = new WebSocket(this.uri, {
      handshakeTimeout: 10000,
    });

    ws.on('open', () => {
      this._ws = ws;
      this._connected = true;
      this._reconnectAttempt = 0;
      log.info('Connected to brain server');
      this._startHeartbeat();
      this.emit('connected');
      if (onFirstConnect) {
        onFirstConnect();
        onFirstConnect = null;
        onFirstFail = null;
      }
    });

    ws.on('message', (raw) => {
      this._onMessage(raw);
    });

    ws.on('close', (code, reason) => {
      this._connected = false;
      clearInterval(this._heartbeatTimer);
      log.warn(`Brain connection closed: ${code} ${reason || ''}`);
      this.emit('disconnected', { code, reason: reason?.toString() });

      if (!this._shutdown) {
        this._scheduleReconnect();
      }
    });

    ws.on('error', (err) => {
      log.error('Brain WebSocket error:', err.message);
      this.emit('error', err);

      if (onFirstFail && this._reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
        onFirstFail(new Error(`Failed to connect to brain after ${MAX_RECONNECT_ATTEMPTS} attempts`));
        onFirstFail = null;
        onFirstConnect = null;
      }
    });
  }

  _onMessage(raw) {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      log.warn('Received non-JSON from brain:', raw.toString().slice(0, 100));
      return;
    }

    const requestId = data.request_id;

    // Stream chunk (raw JSON tokens)
    if (data.type === 'stream_chunk' && requestId) {
      const pending = this._pendingRequests.get(requestId);
      if (pending?.stream) {
        this.emit('brain:chunk', { requestId, content: data.content });
      }
      return;
    }

    // TTS chunk (speakable text extracted from the "text" field)
    if (data.type === 'tts_chunk' && requestId) {
      this.emit('brain:tts_chunk', { requestId, text: data.text });
      return;
    }

    // Full response
    if (data.type === 'response' && requestId) {
      const pending = this._pendingRequests.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this._pendingRequests.delete(requestId);
        pending.resolve(data);
      }
      this.emit('brain:response', data);
      return;
    }

    // Error from brain
    if (data.error) {
      log.warn(`Brain error: ${data.message || data.error}`);
      if (requestId) {
        const pending = this._pendingRequests.get(requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this._pendingRequests.delete(requestId);
          pending.reject(new Error(data.message || data.error));
        }
      }
      return;
    }

    log.debug('Unhandled brain message:', data);
  }

  _startHeartbeat() {
    clearInterval(this._heartbeatTimer);
    this._heartbeatTimer = setInterval(() => {
      if (this._ws?.readyState === WebSocket.OPEN) {
        this._ws.ping();
      }
    }, HEARTBEAT_INTERVAL);
    if (this._heartbeatTimer.unref) this._heartbeatTimer.unref();
  }

  _scheduleReconnect() {
    if (this._shutdown || this._reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      if (this._reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
        log.error(`Gave up reconnecting after ${MAX_RECONNECT_ATTEMPTS} attempts`);
        this.emit('give_up');
      }
      return;
    }

    this._reconnectAttempt++;
    const delay = Math.min(
      BASE_RECONNECT_DELAY * 2 ** (this._reconnectAttempt - 1) + Math.random() * 500,
      MAX_RECONNECT_DELAY,
    );
    log.info(`Reconnecting in ${Math.round(delay)}ms (attempt ${this._reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS})`);

    this._reconnectTimer = setTimeout(() => {
      this._connect();
    }, delay);
    if (this._reconnectTimer.unref) this._reconnectTimer.unref();
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────

let _instance = null;

export function getBrainConnector(opts) {
  if (!_instance) {
    _instance = new BrainConnector(opts);
  }
  return _instance;
}

export default BrainConnector;
