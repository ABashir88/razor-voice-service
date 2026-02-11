/**
 * Visual Cortex Bridge Server
 *
 * WebSocket server that connects Razor's voice pipeline to the Visual Cortex
 * sphere UI. Broadcasts state changes, transcriptions, and audio energy in
 * real-time for visual feedback.
 *
 * Expected by razor-sphere.html on ws://localhost:3333
 *
 * Usage (from orchestrator):
 *   import bridge from './visual-cortex-bridge.js';
 *   bridge.start();       // port 3333
 *   bridge.setState('LISTENING');
 *   bridge.setEnergy(0.5);
 *   bridge.showTranscript('user', 'What deals should I prioritize?');
 *
 * Usage (standalone with demo):
 *   node src/visual-cortex-bridge.js
 */

import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import { fileURLToPath } from 'url';
import makeLogger from './utils/logger.js';

const log = makeLogger('VisualCortex');

class VisualCortexBridge {
  constructor() {
    this.wss = null;
    this.server = null;
    this.clients = new Set();
    this.messageCount = 0;
    this.startTime = Date.now();
    this.currentState = 'IDLE';
    this.currentEnergy = 0;
    this.demoEnabled = true;
  }

  /**
   * Start the WebSocket server
   * @param {number} port - Port to listen on (default: 3333, matches razor-sphere.html)
   */
  start(port = 3333) {
    this.server = http.createServer((req, res) => {
      if (req.url === '/health') {
        this._handleHealth(req, res);
      } else if (req.url === '/stats') {
        this._handleStats(req, res);
      } else if (req.url === '/') {
        this._handleRoot(req, res);
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    });

    this.wss = new WebSocketServer({ server: this.server });

    this.wss.on('connection', (ws) => {
      const clientId = `client_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
      ws.clientId = clientId;
      this.clients.add(ws);

      log.info(`[Bridge] Sphere client connected (${this.clients.size} total)`);

      // Send current state snapshot so late-joining clients sync immediately
      this._sendToClient(ws, {
        type: 'snapshot',
        state: this.currentState,
        energy: this.currentEnergy,
        demoEnabled: this.demoEnabled,
      });

      ws.on('message', (message) => {
        try {
          const msg = JSON.parse(message);
          if (msg.type === 'ping') {
            this._sendToClient(ws, { type: 'pong' });
          } else if (msg.type === 'toggleDemo') {
            this.demoEnabled = !this.demoEnabled;
            log.info(`[Bridge] Demo mode ${this.demoEnabled ? 'ENABLED' : 'DISABLED'}`);
            this._broadcast({ type: 'demoState', enabled: this.demoEnabled });
          }
        } catch (e) {
          log.error('Invalid message from client:', e.message);
        }
      });

      ws.on('close', () => {
        this.clients.delete(ws);
        log.info(`[Bridge] Sphere client disconnected (${this.clients.size} remaining)`);
      });

      ws.on('error', (error) => {
        log.error(`Client error ${clientId}:`, error.message);
        this.clients.delete(ws);
      });
    });

    this.server.listen(port, () => {
      log.info(`[Bridge] WebSocket server ready on ws://localhost:${port}`);
      log.info(`[Bridge] Health: http://localhost:${port}/health`);
    });
  }

  /**
   * Set the current voice pipeline state
   * @param {string} state - IDLE | LISTENING | PROCESSING | SPEAKING
   */
  setState(state) {
    const valid = ['IDLE', 'LISTENING', 'PROCESSING', 'SPEAKING'];
    if (!valid.includes(state)) {
      log.error(`[Bridge] Invalid state: ${state}`);
      return;
    }
    const prev = this.currentState;
    this.currentState = state;
    log.info(`[Bridge] Received state: ${state}`);
    const sent = this._broadcast({ type: 'state', state });
    log.info(`[Bridge] Broadcasting to ${sent} client(s): ${prev} → ${state}`);
  }

  /**
   * Set audio energy level (drives wave animation intensity)
   * @param {number} rms - Energy level 0.0-1.0
   */
  setEnergy(rms) {
    const energy = Math.max(0, Math.min(1, rms));
    this.currentEnergy = energy;
    this._broadcast({ type: 'energy', rms: energy });
  }

  /**
   * Show transcription in the sphere UI
   * @param {'user'|'razor'} speaker
   * @param {string} text
   */
  showTranscript(speaker, text) {
    this._broadcast({ type: 'transcript', speaker, text });
    log.info(`[Bridge] Transcript [${speaker}]: ${text.slice(0, 60)}${text.length > 60 ? '...' : ''}`);
  }

  /** Clear the transcript display */
  clearTranscript() {
    this._broadcast({ type: 'transcript', speaker: 'razor', text: '' });
  }

  /** Send arbitrary message */
  send(message) {
    this._broadcast(message);
  }

  // ── Internal ──

  _broadcast(message) {
    const payload = JSON.stringify({ ...message, timestamp: Date.now() });
    let sent = 0;

    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(payload);
          sent++;
        } catch (e) {
          log.error(`[Bridge] Send failed ${client.clientId}:`, e.message);
        }
      }
    }

    this.messageCount++;
    return sent;
  }

  _sendToClient(client, message) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ ...message, timestamp: Date.now() }));
    }
  }

  _handleHealth(req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'healthy',
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      clients: this.clients.size,
      messagesSent: this.messageCount,
      currentState: this.currentState,
      currentEnergy: this.currentEnergy,
      demoEnabled: this.demoEnabled,
    }));
  }

  _handleStats(req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      connectedClients: this.clients.size,
      totalMessagesSent: this.messageCount,
      currentState: this.currentState,
      clientList: Array.from(this.clients).map(c => ({
        id: c.clientId,
        state: c.readyState === WebSocket.OPEN ? 'open' : 'closed',
      })),
    }));
  }

  _handleRoot(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<html><head><title>Razor Visual Cortex</title></head>
<body style="font-family:monospace;padding:40px;background:#000;color:#64FFDA">
<h1>Razor Visual Cortex Bridge</h1>
<p>WebSocket: <b>ws://localhost:3333</b></p>
<p>Clients: <b>${this.clients.size}</b> | State: <b>${this.currentState}</b></p>
<p><a href="/health" style="color:#64FFDA">Health</a> | <a href="/stats" style="color:#64FFDA">Stats</a></p>
<p>Open <b>razor-sphere.html</b> in browser to see the visualization.</p>
</body></html>`);
  }

  stop() {
    if (this.wss) { this.wss.close(); log.info('[Bridge] WebSocket server stopped'); }
    if (this.server) { this.server.close(); log.info('[Bridge] HTTP server stopped'); }
  }
}

// Singleton
const bridge = new VisualCortexBridge();
export default bridge;

// ── Standalone mode: start server + demo simulator ──
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  bridge.start(3333);

  log.info('[Bridge] Running in standalone demo mode — simulating voice events every 15s');

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function simulateEnergy(durationMs) {
    let step = 0;
    const steps = durationMs / 50;
    const timer = setInterval(() => {
      const phase = (step / steps) * Math.PI * 2;
      const e = 0.05 + Math.sin(phase) * 0.03 + Math.sin(phase * 2.7) * 0.02 + Math.random() * 0.01;
      bridge.setEnergy(e);
      step++;
      if (step >= steps) { clearInterval(timer); bridge.setEnergy(0); }
    }, 50);
  }

  let demoN = 0;
  async function runDemo() {
    const ok = () => bridge.demoEnabled;

    demoN++;
    log.info(`[Bridge] [Demo] === Cycle ${demoN} start ===`);

    log.info('[Bridge] [Demo] State: IDLE');
    bridge.setState('IDLE');
    await sleep(2000);
    if (!ok()) return;

    log.info('[Bridge] [Demo] State: LISTENING');
    bridge.setState('LISTENING');
    simulateEnergy(1500);
    await sleep(500);
    if (!ok()) return;
    bridge.showTranscript('user', 'What deals should I prioritize this week?');
    await sleep(2000);
    if (!ok()) return;

    log.info('[Bridge] [Demo] State: PROCESSING');
    bridge.setState('PROCESSING');
    await sleep(1500);
    if (!ok()) return;
    bridge.showTranscript('razor', 'Pulling Salesforce pipeline data...');
    await sleep(1000);
    if (!ok()) return;

    log.info('[Bridge] [Demo] State: SPEAKING');
    bridge.setState('SPEAKING');
    simulateEnergy(4000);
    bridge.showTranscript('razor', '3 deals closing Friday, $127K total. UnifyGTM at $85K is your biggest. Start there.');
    await sleep(5000);
    if (!ok()) return;

    log.info('[Bridge] [Demo] State: IDLE (cycle end)');
    bridge.setState('IDLE');
    bridge.clearTranscript();
  }

  setInterval(() => {
    if (!bridge.demoEnabled) return;
    runDemo().catch(e => log.error('Demo error:', e.message));
  }, 15000);
  // Run first demo after 2s
  setTimeout(() => {
    if (!bridge.demoEnabled) return;
    runDemo().catch(e => log.error('Demo error:', e.message));
  }, 2000);
}
