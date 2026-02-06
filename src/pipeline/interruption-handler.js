// src/pipeline/interruption-handler.js – Interruption detection during playback
//
// Monitors mic energy while TTS is playing. If speech is detected:
//   1. Kill afplay immediately
//   2. Unmute mic (no 300ms buffer — immediate for responsiveness)
//   3. Transition pipeline to listening state
//
// The challenge: during playback the mic is muted for feedback prevention.
// The interruption handler uses a SEPARATE energy check channel that
// bypasses the mute flag — it listens to raw audio even when the
// main pipeline mic is muted.

import EventEmitter from 'eventemitter3';
import config from '../config.js';
import makeLogger from '../utils/logger.js';

const log = makeLogger('Interrupt');

// Compute RMS of PCM 16-bit LE buffer
function computeRMS(pcmBuffer) {
  const samples = pcmBuffer.length / 2;
  if (samples === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < pcmBuffer.length; i += 2) {
    const sample = pcmBuffer.readInt16LE(i) / 32768;
    sumSq += sample * sample;
  }
  return Math.sqrt(sumSq / samples);
}

class InterruptionHandler extends EventEmitter {
  constructor(playback) {
    super();
    this.playback = playback;
    this.monitoring = false;
    this.consecutiveSpeechFrames = 0;
    this.requiredFrames = 3; // require 3 consecutive speech frames to avoid false triggers

    // Higher threshold during playback (speaker bleed into mic)
    // Even with separate input/output devices, there can be acoustic coupling
    this.interruptThreshold = config.vad.energyThreshold * 3;
  }

  // ── Start monitoring for interruptions ──
  // Called when playback starts
  startMonitoring() {
    this.monitoring = true;
    this.consecutiveSpeechFrames = 0;
    log.debug('Interruption monitoring ACTIVE');
  }

  // ── Stop monitoring ──
  // Called when playback ends
  stopMonitoring() {
    this.monitoring = false;
    this.consecutiveSpeechFrames = 0;
    log.debug('Interruption monitoring INACTIVE');
  }

  // ── Check audio chunk for interruption ──
  // This receives RAW audio BEFORE the mic mute gate
  // (the capture module should call this even when muted)
  checkChunk(pcmChunk) {
    if (!this.monitoring) return;
    if (!this.playback.isPlaying) return;

    const rms = computeRMS(pcmChunk);

    if (rms > this.interruptThreshold) {
      this.consecutiveSpeechFrames++;

      if (this.consecutiveSpeechFrames >= this.requiredFrames) {
        log.warn(`Interruption detected! (energy=${rms.toFixed(4)}, frames=${this.consecutiveSpeechFrames})`);
        this.emit('interrupt');
        this.stopMonitoring();
      }
    } else {
      // Reset counter on silence
      this.consecutiveSpeechFrames = 0;
    }
  }
}

export default InterruptionHandler;
