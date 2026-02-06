// src/audio/capture.js – Continuous audio capture from Bluetooth HFP mic
//
// Uses sox (via node-record-lpcm16) to capture PCM 16kHz mono 16-bit
// from the Ortizan X8 Pro via macOS HFP Bluetooth profile.
//
// Emits:
//   'data'    → raw PCM Buffer chunks (no WAV header)
//   'error'   → recording error
//   'started' → recording started
//   'stopped' → recording stopped

import record from 'node-record-lpcm16';
import EventEmitter from 'eventemitter3';
import config from '../config.js';
import makeLogger from '../utils/logger.js';

const log = makeLogger('Capture');

class AudioCapture extends EventEmitter {
  constructor() {
    super();
    this.recording = null;
    this.stream = null;
    this.muted = false;
    this.running = false;

    // Software gain: amplify mic input so user doesn't have to yell
    const gainDb = config.audio.inputGainDb;
    this.gainMultiplier = gainDb > 0 ? Math.pow(10, gainDb / 20) : 1.0;
    if (gainDb > 0) {
      log.info(`Software gain: +${gainDb}dB (${this.gainMultiplier.toFixed(1)}x)`);
    }

    // Track total bytes for diagnostics
    this.totalBytes = 0;
    this.startTime = 0;
  }

  /** Amplify PCM 16-bit LE samples by gain multiplier with clamp to prevent clipping */
  _applyGain(pcmBuffer) {
    const result = Buffer.allocUnsafe(pcmBuffer.length);
    for (let i = 0; i < pcmBuffer.length; i += 2) {
      let sample = pcmBuffer.readInt16LE(i);
      sample = Math.round(sample * this.gainMultiplier);
      if (sample > 32767) sample = 32767;
      else if (sample < -32768) sample = -32768;
      result.writeInt16LE(sample, i);
    }
    return result;
  }

  // ── Start continuous recording ──
  start() {
    if (this.running) {
      log.warn('Already recording');
      return;
    }

    log.info(`Starting mic capture: ${config.audio.sampleRate}Hz, ${config.audio.channels}ch, ${config.audio.bitDepth}-bit`);

    this.recording = record.record({
      sampleRate: config.audio.sampleRate,
      channels: config.audio.channels,
      audioType: 'wav',
      recorder: 'sox',
    });

    this.stream = this.recording.stream();
    this.running = true;
    this.totalBytes = 0;
    this.startTime = Date.now();

    // Monitor the child process for early exit / stderr diagnostics
    const cp = this.recording.process;
    if (cp) {
      cp.stderr?.on('data', (chunk) => {
        const msg = chunk.toString().trim();
        if (msg && !msg.includes('Length in output .wav header')) {
          log.warn('sox stderr:', msg);
        }
      });
    }

    // Skip the first 44 bytes (WAV header) from sox
    let headerSkipped = false;
    let headerBuf = Buffer.alloc(0);

    this.stream.on('data', (chunk) => {
      if (!headerSkipped) {
        headerBuf = Buffer.concat([headerBuf, chunk]);
        if (headerBuf.length >= 44) {
          // Emit everything after the 44-byte WAV header
          let pcmStart = headerBuf.subarray(44);
          headerSkipped = true;
          if (pcmStart.length > 0 && !this.muted) {
            if (this.gainMultiplier !== 1.0) pcmStart = this._applyGain(pcmStart);
            this.totalBytes += pcmStart.length;
            this.emit('data', pcmStart);
          }
        }
        return;
      }

      if (this.muted) return; // feedback loop prevention

      const pcm = this.gainMultiplier !== 1.0 ? this._applyGain(chunk) : chunk;
      this.totalBytes += pcm.length;
      this.emit('data', pcm);
    });

    this.stream.on('error', (err) => {
      // node-record-lpcm16 emits errors as strings, not Error objects
      const message = typeof err === 'string' ? err : (err?.message || String(err));
      log.error('Recording stream error:', message);
      this.emit('error', err);
    });

    this.stream.on('end', () => {
      const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
      if (this.totalBytes === 0) {
        log.error(`Recording stream ended after ${elapsed}s with NO data — sox likely crashed (check audio device)`);
      } else {
        log.info(`Recording stream ended (${elapsed}s, ${(this.totalBytes / 1024).toFixed(0)}KB)`);
      }
      this.running = false;
      this.emit('stopped');
    });

    log.info('Mic capture started ✓');
    this.emit('started');
  }

  // ── Stop recording ──
  stop() {
    if (!this.running) return;

    try {
      this.recording?.stop();
    } catch (err) {
      log.warn('Error stopping recording:', err.message);
    }

    this.running = false;
    this.recording = null;
    this.stream = null;

    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    log.info(`Mic capture stopped (${elapsed}s, ${(this.totalBytes / 1024).toFixed(0)}KB)`);
    this.emit('stopped');
  }

  // ── Mute (for feedback loop prevention during TTS playback) ──
  mute() {
    if (!this.muted) {
      this.muted = true;
      log.debug('Mic MUTED (playback active)');
    }
  }

  // ── Unmute (with configurable delay for the 300ms buffer) ──
  unmute(delayMs = config.tts.playbackMuteBufferMs) {
    if (!this.muted) return;

    if (delayMs > 0) {
      setTimeout(() => {
        this.muted = false;
        log.debug(`Mic UNMUTED (after ${delayMs}ms buffer)`);
      }, delayMs);
    } else {
      this.muted = false;
      log.debug('Mic UNMUTED');
    }
  }

  // ── Force unmute immediately (for interruption handling) ──
  unmuteNow() {
    this.muted = false;
    log.debug('Mic UNMUTED (immediate — interruption)');
  }

  get isRunning() {
    return this.running;
  }

  get isMuted() {
    return this.muted;
  }
}

export default AudioCapture;
