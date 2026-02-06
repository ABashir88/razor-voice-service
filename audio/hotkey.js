/**
 * Hotkey / Input Handler
 * 
 * Two input modes:
 *   1. Terminal PTT — SPACE/R toggles recording (interactive mode)
 *   2. HTTP API — curl localhost:3457/ptt (LaunchAgent mode / keyboard shortcut)
 * 
 * The HTTP server also handles health, state, speak, and stop endpoints.
 */
import { createServer } from 'node:http';
import { log, logError } from '../lib/log.js';

/**
 * Set up terminal keyboard listener for push-to-talk.
 * Only works when running interactively (TTY).
 */
export function setupTerminalPTT(callbacks) {
  if (!process.stdin.isTTY) return false;

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');

  process.stdin.on('data', (key) => {
    if (key === '\u0003' || key === 'q' || key === 'Q') {
      callbacks.onQuit?.();
      return;
    }
    if (key === ' ' || key === 'r' || key === 'R') {
      callbacks.onPTT?.();
    }
    if (key === 's' || key === 'S') {
      callbacks.onStop?.();
    }
  });

  return true;
}

/**
 * Start the HTTP control server.
 */
export function startHTTPServer(port, bind, handlers) {
  const server = createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      const url = req.url?.split('?')[0];

      // ── PTT Toggle ──
      if (url === '/ptt' || url === '/ptt/toggle') {
        const result = await handlers.onPTT();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      // ── PTT Start / Stop ──
      if (url === '/ptt/start') {
        await handlers.onPTTStart();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, recording: true }));
        return;
      }
      if (url === '/ptt/stop') {
        handlers.onPTTStop();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, processing: true }));
        return;
      }

      // ── Speak Text (proactive alerts) ──
      if (url === '/speak' && req.method === 'POST') {
        const body = await readBody(req);
        const { text } = JSON.parse(body);
        if (text) handlers.onSpeak(text);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // ── State Change ──
      if (url?.startsWith('/state/')) {
        const newState = url.replace('/state/', '');
        const result = await handlers.onStateChange(newState);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      // ── Stop Playback ──
      if (url === '/stop') {
        handlers.onStopPlayback();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // ── Health ──
      if (url === '/health') {
        const health = handlers.onHealth();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(health));
        return;
      }

      // ── Status (detailed) ──
      if (url === '/status') {
        const status = handlers.onStatus();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(status));
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    } catch (err) {
      logError('HTTP handler', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  server.listen(port, bind, () => {
    log('✅', `HTTP API on http://${bind}:${port}`);
  });

  return server;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}
