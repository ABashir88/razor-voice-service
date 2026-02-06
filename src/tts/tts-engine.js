// src/tts/tts-engine.js – Text-to-Speech with Telnyx, ElevenLabs, or macOS say
//
// ── Voice Quality Research & Recommendations ──
//
// TELNYX (recommended for low latency + cost):
//   Best male voices (ranked by naturalness):
//   1. Telnyx.KokoroTTS.am_adam    – warm, natural pacing
//   2. Telnyx.KokoroTTS.am_michael – clear, authoritative
//   3. Telnyx.Natural.alpine       – conversational
//   4. Telnyx.NaturalHD.orion      – HD quality, deeper
//   Latency: ~500-1300ms first byte | Cost: included in Telnyx plan
//
// ELEVENLABS (alternative for maximum naturalness):
//   Best male voices (ranked):
//   1. "Adam"  (pNInz6obpgDQGcFmaJgB) – Deep, warm, broadcast quality
//   2. "Josh"  (TxGEqnHWrfWFTfGW9XjX) – Conversational, friendly
//   3. "Sam"   (yoZ06aMxZJJ28mfd3POQ) – Calm, articulate
//   Model: eleven_turbo_v2_5 (lowest latency, still great quality)
//   Latency: ~300-600ms first byte | Cost: per-character pricing
//
// MACOS (offline fallback — no API key needed):
//   Uses the native `say` command. Best voices: Samantha, Daniel
//   Latency: ~50-200ms | Cost: free | Quality: decent, not natural
//
// Features:
//   • Dynamic pacing via pace parameter ('urgent', 'normal', 'calm')
//   • Automatic fallback: cloud provider → macOS say when API key missing
//   • Returns audio buffer ready for AudioPlayback

import { execFile } from 'child_process';
import { readFile, unlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { promisify } from 'util';
import config from '../config.js';
import makeLogger from '../utils/logger.js';

const execFileAsync = promisify(execFile);
const log = makeLogger('TTS');

class TtsEngine {
  constructor() {
    this.provider = this._resolveProvider();
    this._ackFiles = []; // Pre-cached acknowledgment audio file paths
    log.info(`TTS provider: ${this.provider}`);
  }

  /**
   * Pre-generate a subtle acknowledgment tone for instant playback.
   * Uses sox to create a short, quiet tone — nearly imperceptible, like a nod.
   * Called at startup so the ack plays with zero latency.
   */
  async warmup() {
    // Generate a 100ms, 660Hz sine wave at low volume with smooth fades
    // Result: a soft "blip" — not a voice, not jarring, just a subtle cue
    const filepath = join(tmpdir(), 'razor-ack-tone.wav');
    try {
      await execFileAsync('sox', [
        '-n', filepath,
        'synth', '0.1', 'sine', '660',
        'vol', '0.15',
        'fade', 't', '0.01', '0.1', '0.02',
      ]);
      this._ackFiles.push(filepath);
      log.info('Generated subtle ack tone for instant playback');
    } catch (err) {
      log.warn('Failed to generate ack tone:', err.message);
    }
  }

  /** Get a random pre-cached ack file path, or null if none available. */
  getRandomAckFile() {
    if (!this._ackFiles.length) return null;
    return this._ackFiles[Math.floor(Math.random() * this._ackFiles.length)];
  }

  /**
   * Determine the effective provider. If the configured cloud provider
   * has no API key, automatically fall back to macOS say.
   */
  _resolveProvider() {
    const requested = config.tts.provider;

    if (requested === 'macos') return 'macos';

    if (requested === 'elevenlabs' && config.tts.elevenlabs.apiKey) return 'elevenlabs';
    if (requested === 'telnyx' && config.tts.telnyx.apiKey) return 'telnyx';

    // Configured provider has no API key — fall back
    if (requested === 'elevenlabs' || requested === 'telnyx') {
      log.warn(`${requested} selected but no API key found — falling back to macOS say`);
    }
    return 'macos';
  }

  /**
   * Synthesize text to audio buffer.
   * @returns {{ buffer: Buffer, format: string } | null}
   */
  async synthesize(text, { pace = 'normal' } = {}) {
    if (!text || text.trim().length === 0) {
      log.warn('Empty text — skipping TTS');
      return null;
    }

    // Truncate long responses for speed — spoken output should be brief
    const maxChars = config.tts.maxCharsForSpeed || 200;
    if (text.length > maxChars) {
      const truncated = text.slice(0, maxChars);
      // Cut at last sentence boundary for natural speech
      const lastEnd = Math.max(
        truncated.lastIndexOf('. '),
        truncated.lastIndexOf('! '),
        truncated.lastIndexOf('? '),
      );
      text = lastEnd > maxChars * 0.4 ? truncated.slice(0, lastEnd + 1) : truncated;
      log.info(`Truncated TTS text to ${text.length} chars for speed`);
    }

    const paceConfig = config.pacing[pace] || config.pacing.normal;
    log.info(`Synthesizing (${this.provider}, pace=${pace}): "${text.slice(0, 80)}${text.length > 80 ? '...' : ''}"`);

    const start = Date.now();

    try {
      let result;
      if (this.provider === 'elevenlabs') {
        result = await this.synthesizeElevenLabs(text, paceConfig);
      } else if (this.provider === 'telnyx') {
        result = await this.synthesizeTelnyx(text, paceConfig);
      } else {
        result = await this.synthesizeMacOS(text, pace);
      }

      const latency = Date.now() - start;
      log.info(`TTS complete: ${(result.buffer.length / 1024).toFixed(0)}KB, ${latency}ms`);
      return result;
    } catch (err) {
      log.error(`TTS synthesis failed (${this.provider}): ${err.message}`);

      // If a cloud provider fails at runtime, try macOS as emergency fallback
      if (this.provider !== 'macos') {
        log.warn('Attempting macOS say fallback...');
        try {
          const result = await this.synthesizeMacOS(text, pace);
          const latency = Date.now() - start;
          log.info(`TTS fallback complete: ${(result.buffer.length / 1024).toFixed(0)}KB, ${latency}ms`);
          return result;
        } catch (fallbackErr) {
          log.error('macOS say fallback also failed:', fallbackErr.message);
        }
      }
      throw err;
    }
  }

  // ── macOS native say ──
  async synthesizeMacOS(text, pace = 'normal') {
    const voice = config.tts.macos.voice;
    const wpmMap = {
      urgent: config.tts.macos.wpmUrgent,
      normal: config.tts.macos.wpmNormal,
      calm: config.tts.macos.wpmCalm,
    };
    const wpm = wpmMap[pace] || wpmMap.normal;

    const tmpFile = join(tmpdir(), `razor-say-${randomUUID().slice(0, 8)}.aiff`);

    try {
      await execFileAsync('say', ['-v', voice, '-r', String(wpm), '-o', tmpFile, text]);
      const buffer = await readFile(tmpFile);
      return { buffer, format: 'aiff' };
    } finally {
      unlink(tmpFile).catch(() => {});
    }
  }

  // ── Telnyx TTS ──
  async synthesizeTelnyx(text, paceConfig) {
    const apiKey = config.tts.telnyx.apiKey;
    if (!apiKey) throw new Error('No Telnyx API key. Set TELNYX_API_KEY in .env');

    const response = await fetch(config.tts.telnyx.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        voice: config.tts.telnyx.voice,
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Telnyx TTS ${response.status}: ${errText}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    return { buffer, format: 'mp3' };
  }

  // ── ElevenLabs TTS ──
  async synthesizeElevenLabs(text, paceConfig) {
    const apiKey = config.tts.elevenlabs.apiKey;
    if (!apiKey) throw new Error('No ElevenLabs API key. Set ELEVENLABS_API_KEY in .env');

    const voiceId = config.tts.elevenlabs.voiceId;
    const url = `${config.tts.elevenlabs.endpoint}/${voiceId}`;

    // ElevenLabs controls pacing via stability and speed parameters
    // Derive pace from paceConfig.rate: urgent > 1.0, calm < 1.0
    const stability = paceConfig.rate > 1.05 ? 0.7 : paceConfig.rate < 0.95 ? 0.4 : 0.5;
    const speed = paceConfig.rate;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: config.tts.elevenlabs.model,
        voice_settings: {
          stability,
          similarity_boost: 0.75,
          style: 0.4,
          use_speaker_boost: true,
          speed,
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`ElevenLabs TTS ${response.status}: ${errText}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    return { buffer, format: 'mp3' };
  }

}

export default TtsEngine;
