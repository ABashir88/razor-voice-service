/**
 * Health Server — Standalone HTTP health check endpoint
 *
 * Used by the watchdog and launchd to verify the voice service is alive.
 * Runs on port 3000 (configurable via HEALTH_PORT env).
 *
 * GET /health → { status: "ok", timestamp, uptime }
 */

import http from 'http';
import makeLogger from './utils/logger.js';

const log = makeLogger('Health');
const PORT = parseInt(process.env.HEALTH_PORT, 10) || 3000;
const startTime = Date.now();

let server = null;

function start() {
  if (server) return;

  server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: Math.floor((Date.now() - startTime) / 1000),
      }));
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log.warn(`Port ${PORT} in use — health server disabled`);
      server = null;
    } else {
      log.error('Health server error:', err.message);
    }
  });

  server.listen(PORT, '127.0.0.1', () => {
    log.info(`Health server listening on http://127.0.0.1:${PORT}/health`);
  });
}

function stop() {
  if (server) {
    server.close();
    server = null;
    log.info('Health server stopped');
  }
}

export default { start, stop };
