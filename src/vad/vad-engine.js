// src/vad/vad-engine.js – Energy-based Voice Activity Detection
//
// Processes raw PCM 16-bit LE mono audio chunks and detects speech segments.
// Uses RMS energy thresholding with:
//   • Minimum speech duration filter (to reject clicks/pops)
//   • Silence timeout for end-of-utterance detection
//   • Accumulates PCM frames during speech for downstream processing
//
// Emits:
//   'speech:start'  → speech detected (after speechMinMs)
//   'speech:data'   → ongoing speech PCM data (Buffer)
//   'speech:end'    → { audio: Buffer, durationMs: number } complete utterance

import EventEmitter from 'eventemitter3';
import config from '../config.js';
import makeLogger from '../utils/logger.js';

const log = makeLogger('VAD');

// ── Compute RMS energy of a PCM 16-bit LE buffer ──
function computeRMS(pcmBuffer) {
  const samples = pcmBuffer.length / 2; // 16-bit = 2 bytes per sample
  if (samples === 0) return 0;

  let sumSq = 0;
  for (let i = 0; i < pcmBuffer.length; i += 2) {
    const sample = pcmBuffer.readInt16LE(i) / 32768; // normalize to [-1, 1]
    sumSq += sample * sample;
  }

  return Math.sqrt(sumSq / samples);
}

class VadEngine extends EventEmitter {
  constructor(options = {}) {
    super();

    this.energyThreshold = options.energyThreshold ?? config.vad.energyThreshold;
    this.silenceDurationMs = options.silenceDurationMs ?? config.vad.silenceDurationMs;
    this.speechMinMs = options.speechMinMs ?? config.vad.speechMinMs;
    this.sampleRate = config.audio.sampleRate;

    // State
    this.isSpeaking = false;
    this.speechStartTime = 0;
    this.lastSpeechTime = 0;
    this.speechBuffers = [];
    this.totalSpeechBytes = 0;
    this.silenceTimer = null;

    // Ring buffer for adaptive threshold (optional)
    this.energyHistory = [];
    this.energyHistoryMax = 100;
  }

  // ── Process incoming PCM audio chunk ──
  process(pcmChunk) {
    const rms = computeRMS(pcmChunk);

    // Track energy history for debugging / adaptive threshold
    this.energyHistory.push(rms);
    if (this.energyHistory.length > this.energyHistoryMax) {
      this.energyHistory.shift();
    }

    const isSpeech = rms > this.energyThreshold;

    if (isSpeech) {
      this.lastSpeechTime = Date.now();

      if (!this.isSpeaking) {
        // Potential speech start — begin accumulating
        this.isSpeaking = true;
        this.speechStartTime = Date.now();
        this.speechBuffers = [];
        this.totalSpeechBytes = 0;

        // Clear any pending silence timer
        if (this.silenceTimer) {
          clearTimeout(this.silenceTimer);
          this.silenceTimer = null;
        }
      }

      // Accumulate speech data
      this.speechBuffers.push(pcmChunk);
      this.totalSpeechBytes += pcmChunk.length;
      this.emit('speech:data', pcmChunk);

      // Emit speech:start only after minimum duration
      const elapsed = Date.now() - this.speechStartTime;
      if (elapsed >= this.speechMinMs && this.speechBuffers.length === Math.ceil(this.speechMinMs / (pcmChunk.length / 2 / this.sampleRate * 1000)) + 1) {
        log.debug(`Speech started (energy=${rms.toFixed(4)})`);
        this.emit('speech:start');
      }
    } else if (this.isSpeaking) {
      // Still accumulate during brief silences within speech
      this.speechBuffers.push(pcmChunk);
      this.totalSpeechBytes += pcmChunk.length;

      // Start silence timer if not already running
      if (!this.silenceTimer) {
        this.silenceTimer = setTimeout(() => {
          this.endSpeech();
        }, this.silenceDurationMs);
      }
    }
  }

  // ── Finalize speech segment ──
  endSpeech() {
    if (!this.isSpeaking) return;

    const durationMs = Date.now() - this.speechStartTime;

    // Reject very short bursts (clicks, pops)
    if (durationMs < this.speechMinMs) {
      log.debug(`Rejected short burst: ${durationMs}ms`);
      this.reset();
      return;
    }

    const audio = Buffer.concat(this.speechBuffers);
    const durationSec = (durationMs / 1000).toFixed(1);

    log.info(`Speech ended: ${durationSec}s, ${(audio.length / 1024).toFixed(0)}KB`);

    this.emit('speech:end', {
      audio,
      durationMs,
      sampleRate: this.sampleRate,
    });

    this.reset();
  }

  // ── Force end (e.g., when pipeline needs to flush) ──
  flush() {
    if (this.isSpeaking) {
      if (this.silenceTimer) {
        clearTimeout(this.silenceTimer);
        this.silenceTimer = null;
      }
      this.endSpeech();
    }
  }

  // ── Reset state ──
  reset() {
    this.isSpeaking = false;
    this.speechStartTime = 0;
    this.lastSpeechTime = 0;
    this.speechBuffers = [];
    this.totalSpeechBytes = 0;
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  // ── Diagnostics ──
  getStats() {
    const energies = this.energyHistory;
    if (energies.length === 0) return { avg: 0, max: 0, min: 0, threshold: this.energyThreshold };

    return {
      avg: (energies.reduce((a, b) => a + b, 0) / energies.length).toFixed(5),
      max: Math.max(...energies).toFixed(5),
      min: Math.min(...energies).toFixed(5),
      threshold: this.energyThreshold,
      speaking: this.isSpeaking,
    };
  }
}

export default VadEngine;
