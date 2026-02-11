// src/stt/deepgram-stream.js – Streaming STT via Deepgram WebSocket
//
// Used after wake word detection to transcribe the user's command
// in real-time via Deepgram's live streaming API.
//
// Emits:
//   'transcript:partial' → { text, isFinal: false }
//   'transcript:final'   → { text, isFinal: true, confidence }
//   'transcript:error'   → error
//   'closed'             → WebSocket closed

import { WebSocket } from 'ws';
import EventEmitter from 'eventemitter3';
import config from '../config.js';
import makeLogger from '../utils/logger.js';

const log = makeLogger('STT');

class DeepgramStream extends EventEmitter {
  constructor(options = {}) {
    super();
    this.ws = null;
    this.connected = false;
    this.closing = false;
    this.endpointingMs = options.endpointingMs ?? config.stt.endpointingMs ?? 3000;
  }

  // ── Open streaming connection ──
  async connect() {
    if (this.connected) return;

    const apiKey = config.stt.deepgramApiKey;
    if (!apiKey) {
      log.error('No Deepgram API key. Set DEEPGRAM_API_KEY in .env');
      return;
    }

    const params = new URLSearchParams({
      model: 'nova-2',
      language: 'en',
      smart_format: 'true',
      interim_results: 'true',
      endpointing: String(this.endpointingMs),
      vad_events: 'true',
      encoding: 'linear16',
      sample_rate: String(config.audio.sampleRate),
      channels: String(config.audio.channels),
    });

    // Domain-specific keyword boosting — helps nova-2 recognize sales/CRM terms
    const KEYWORDS = [
      'pipeline', 'cadences', 'action items', 'meetings', 'priorities',
      'overdue', 'salesforce', 'calendar', 'deals', 'leads',
      'contacts', 'accounts', 'opportunities', 'forecast',
      'tasks', 'follow-ups', 'emails', 'calls', 'demos',
      'proposals', 'contracts', 'quotas', 'metrics',
      'revenue', 'ACV', 'MRR', 'churn', 'conversion',
      'outreach', 'sequences', 'touchpoints', 'engagement', 'CRM',
    ];
    for (const kw of KEYWORDS) {
      params.append('keywords', `${kw}:1.5`);
    }

    const url = `wss://api.deepgram.com/v1/listen?${params}`;

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url, {
        headers: { Authorization: `Token ${apiKey}` },
      });

      const timeout = setTimeout(() => {
        reject(new Error('Deepgram WebSocket connection timeout'));
        this.ws?.close();
      }, 5000);

      this.ws.on('open', () => {
        clearTimeout(timeout);
        this.connected = true;
        this.closing = false;
        log.info('Deepgram streaming connected ✓');
        resolve();
      });

      this.ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());

          if (msg.type === 'Results') {
            const alt = msg.channel?.alternatives?.[0];
            if (!alt) return;

            const text = alt.transcript?.trim();
            if (!text) return;

            if (msg.is_final) {
              log.info(`Final: "${text}" (confidence: ${(alt.confidence * 100).toFixed(0)}%)`);
              this.emit('transcript:final', {
                text,
                isFinal: true,
                confidence: alt.confidence,
              });
            } else {
              log.debug(`Partial: "${text}"`);
              this.emit('transcript:partial', {
                text,
                isFinal: false,
              });
            }
          } else if (msg.type === 'SpeechStarted') {
            log.debug('Deepgram: speech started');
          } else if (msg.type === 'UtteranceEnd') {
            log.debug('Deepgram: utterance end');
            this.emit('utterance:end');
          }
        } catch (err) {
          log.error('Failed to parse Deepgram message:', err.message);
        }
      });

      this.ws.on('close', (code, reason) => {
        this.connected = false;
        if (!this.closing) {
          log.warn(`Deepgram WebSocket closed: ${code} ${reason}`);
        }
        this.emit('closed');
      });

      this.ws.on('error', (err) => {
        clearTimeout(timeout);
        log.error('Deepgram WebSocket error:', err.message);
        this.emit('transcript:error', err);
        if (!this.connected) reject(err);
      });
    });
  }

  // ── Send PCM audio data ──
  send(pcmBuffer) {
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(pcmBuffer);
  }

  // ── Close connection gracefully ──
  async close() {
    if (!this.connected || !this.ws) return;

    this.closing = true;

    // Send close message to Deepgram to flush final results
    try {
      this.ws.send(JSON.stringify({ type: 'CloseStream' }));
    } catch { /* ignore */ }

    // Wait briefly for final transcripts
    await new Promise((r) => setTimeout(r, 500));

    try {
      this.ws.close();
    } catch { /* ignore */ }

    this.connected = false;
  }
}

export default DeepgramStream;
