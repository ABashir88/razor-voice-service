/**
 * OpenClaw Gateway WebSocket Client.
 * 
 * Connects to the local OpenClaw gateway to send/receive chat messages.
 * Handles protocol negotiation, auth, reconnection, and event streaming.
 */
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { log, logError } from '../lib/log.js';

export class GatewayClient {
  constructor(config) {
    this.host = config.gateway.host;
    this.port = config.gateway.port;
    this.configPath = config.gateway.configPath;
    this.url = `ws://${this.host}:${this.port}`;
    this.token = null;
    this.ws = null;
    this.connected = false;
    this.pending = new Map();
    this.eventHandlers = new Map();
    this.onProactive = null;
    this._reconnectTimer = null;
    this._dead = false;
    // Store connect Promise callbacks so challenge handler can resolve them
    this._connectResolve = null;
    this._connectReject = null;
    this._connectTimeout = null;
  }

  async loadToken() {
    try {
      const raw = await readFile(this.configPath, 'utf8');
      const cfg = JSON.parse(raw);
      this.token = cfg?.gateway?.auth?.token;
      if (!this.token) throw new Error('No gateway.auth.token in config');
      return true;
    } catch (err) {
      logError('Failed to read gateway token', err);
      return false;
    }
  }

  async connect() {
    if (!this.token) {
      const loaded = await this.loadToken();
      if (!loaded) throw new Error('No gateway token');
    }

    return new Promise((resolve, reject) => {
      // Store callbacks so _handleFrame can access them
      this._connectResolve = resolve;
      this._connectReject = reject;

      this.ws = new WebSocket(this.url);
      this._connectTimeout = setTimeout(() => {
        if (!this.connected) {
          this._connectResolve = null;
          this._connectReject = null;
          reject(new Error('Connection timeout'));
        }
      }, 10000);

      this.ws.onopen = () => {
        log('🔌', 'Gateway WS opened...');
        setTimeout(() => {
          if (!this.connected) this._sendConnect();
        }, 500);
      };

      this.ws.onmessage = (event) => {
        try {
          this._handleFrame(JSON.parse(event.data));
        } catch {}
      };

      this.ws.onerror = () => {
        clearTimeout(this._connectTimeout);
        this._connectResolve = null;
        this._connectReject = null;
        reject(new Error('Gateway connection failed'));
      };

      this.ws.onclose = () => {
        clearTimeout(this._connectTimeout);
        this.connected = false;
        if (!this._dead) {
          clearTimeout(this._reconnectTimer);
          this._reconnectTimer = setTimeout(() => {
            log('🔄', 'Reconnecting to gateway...');
            this.connect().catch(() => {});
          }, 5000);
        }
      };
    });
  }

  _sendConnect() {
    const id = randomUUID();
    this.pending.set(id, {
      resolve: () => {
        this.connected = true;
        clearTimeout(this._connectTimeout);
        log('✅', 'Gateway connected');
        // Resolve the connect() Promise
        const r = this._connectResolve;
        this._connectResolve = null;
        this._connectReject = null;
        r?.();
      },
      reject: (err) => {
        clearTimeout(this._connectTimeout);
        logError('Gateway auth failed', err);
        const r = this._connectReject;
        this._connectResolve = null;
        this._connectReject = null;
        r?.(err);
      },
      method: 'connect'
    });

    this.ws.send(JSON.stringify({
      type: 'req', id, method: 'connect',
      params: {
        minProtocol: 3, maxProtocol: 3,
        client: {
          id: 'gateway-client',
          version: '1.0.0',
          platform: process.platform,
          mode: 'ui'
        },
        role: 'operator',
        scopes: ['operator.read', 'operator.write'],
        caps: [], commands: [], permissions: {},
        auth: { token: this.token },
        locale: 'en-US',
        userAgent: 'razor-voice/2.0.0'
      }
    }));
  }

  _handleFrame(frame) {
    // ── Events ──
    if (frame.type === 'event') {
      if (frame.event === 'connect.challenge') {
        // Re-send connect with auth (challenge uses stored resolve/reject)
        this._sendConnect();
        return;
      }

      if (frame.event === 'chat' || frame.event === 'agent') {
        const runId = frame.payload?.runId;
        const handlers = this.eventHandlers.get(runId);
        if (handlers) {
          handlers.forEach(h => h(frame));
        } else if (frame.payload?.state === 'final' && this.onProactive) {
          const text = frame.payload?.message?.content?.[0]?.text;
          if (text && text !== 'NO_REPLY' && text !== 'HEARTBEAT_OK') {
            this.onProactive(text);
          }
        }
        return;
      }
      return;
    }

    // ── Responses ──
    if (frame.type === 'res') {
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      this.pending.delete(frame.id);

      if (pending.method === 'connect') {
        frame.ok ? pending.resolve() : pending.reject(new Error(frame.error?.message || 'Connect failed'));
        return;
      }

      frame.ok ? pending.resolve(frame.payload) : pending.reject(new Error(frame.error?.message));
    }
  }

  async request(method, params = {}) {
    if (!this.connected) throw new Error('Not connected');

    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timeout`));
      }, 120000);

      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
        method
      });

      this.ws.send(JSON.stringify({ type: 'req', id, method, params }));
    });
  }

  async sendChat(message, sessionKey = 'main') {
    const runId = randomUUID();

    return new Promise(async (resolve, reject) => {
      let fullText = '';
      const timer = setTimeout(() => {
        this.eventHandlers.delete(runId);
        reject(new Error('Chat timeout (120s)'));
      }, 120000);

      this.eventHandlers.set(runId, [(frame) => {
        if (frame.event !== 'chat') return;
        const p = frame.payload;

        if (p.state === 'delta') {
          const deltaText = p.message?.content?.[0]?.text;
          if (deltaText) fullText = deltaText;
        }

        if (p.state === 'final') {
          clearTimeout(timer);
          this.eventHandlers.delete(runId);
          resolve(p.message?.content?.[0]?.text || fullText);
        }

        if (p.state === 'error') {
          clearTimeout(timer);
          this.eventHandlers.delete(runId);
          reject(new Error(p.errorMessage || 'Chat error'));
        }
      }]);

      try {
        await this.request('chat.send', {
          sessionKey,
          message,
          idempotencyKey: runId,
        });
      } catch (err) {
        clearTimeout(timer);
        this.eventHandlers.delete(runId);
        reject(err);
      }
    });
  }

  disconnect() {
    this._dead = true;
    clearTimeout(this._reconnectTimer);
    clearTimeout(this._connectTimeout);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  get isConnected() { return this.connected; }
}
