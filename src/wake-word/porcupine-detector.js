// src/wake-word/porcupine-detector.js – Porcupine wake word detection
//
// Uses Picovoice Porcupine for low-latency, on-device wake word detection.
// Designed to be swapped in seamlessly when the API key arrives.
//
// To use:
//   1. Set PORCUPINE_ACCESS_KEY in .env
//   2. Optionally train a custom "Razor" keyword at console.picovoice.ai
//      and place the .ppn file in ./models/razor_mac.ppn
//   3. The pipeline auto-selects Porcupine when the key is present
//
// Falls back to built-in "picovoice" keyword if no custom .ppn file exists.
//
// Emits:
//   'wake' → { keywordIndex, timestamp }

import { existsSync } from 'fs';
import { join } from 'path';
import EventEmitter from 'eventemitter3';
import config from '../config.js';
import makeLogger from '../utils/logger.js';

const log = makeLogger('Porcupine');

// Porcupine expects 16kHz mono 16-bit PCM in specific frame sizes
const FRAME_LENGTH = 512; // Porcupine's required frame length at 16kHz

class PorcupineWakeDetector extends EventEmitter {
  constructor() {
    super();
    this.porcupine = null;
    this.initialized = false;
    this.enabled = true;

    // Frame accumulator (Porcupine needs exact frame sizes)
    this.frameBuffer = Buffer.alloc(0);
  }

  // ── Initialize Porcupine engine ──
  async init() {
    const accessKey = config.wakeWord.porcupineAccessKey;
    if (!accessKey) {
      log.error('No Porcupine access key. Set PORCUPINE_ACCESS_KEY in .env');
      return false;
    }

    try {
      // Dynamic import so the app doesn't crash if @picovoice/porcupine-node isn't installed
      const { Porcupine, BuiltinKeyword } = await import('@picovoice/porcupine-node');

      // Check for custom "Razor" keyword model
      const customModelPath = join(config.root, 'models', 'razor_mac.ppn');
      const hasCustomModel = existsSync(customModelPath);

      if (hasCustomModel) {
        log.info(`Using custom wake word model: ${customModelPath}`);
        this.porcupine = new Porcupine(
          accessKey,
          [customModelPath],    // keyword paths
          [0.6]                  // sensitivities (0.0-1.0, higher = more sensitive)
        );
      } else {
        // Use built-in keyword as placeholder until custom model is trained
        log.warn('No custom Razor model found. Using built-in "picovoice" keyword.');
        log.warn('Train a custom keyword at https://console.picovoice.ai');
        log.warn(`Place the .ppn file at: ${customModelPath}`);

        this.porcupine = new Porcupine(
          accessKey,
          [BuiltinKeyword.PICOVOICE],
          [0.5]
        );
      }

      this.initialized = true;
      log.info(`Porcupine initialized ✓ (frame length: ${this.porcupine.frameLength})`);
      return true;
    } catch (err) {
      log.error('Porcupine initialization failed:', err.message);
      if (err.message.includes('access key')) {
        log.error('Your Porcupine access key may be invalid or expired.');
      }
      return false;
    }
  }

  // ── Process PCM audio chunks ──
  // Accumulates data into Porcupine-sized frames and checks each
  process(pcmChunk) {
    if (!this.initialized || !this.enabled || !this.porcupine) return;

    // Accumulate into frame buffer
    this.frameBuffer = Buffer.concat([this.frameBuffer, pcmChunk]);

    const bytesPerFrame = FRAME_LENGTH * 2; // 16-bit = 2 bytes per sample

    // Process complete frames
    while (this.frameBuffer.length >= bytesPerFrame) {
      const frameBytes = this.frameBuffer.subarray(0, bytesPerFrame);
      this.frameBuffer = this.frameBuffer.subarray(bytesPerFrame);

      // Convert to Int16Array for Porcupine
      const frame = new Int16Array(FRAME_LENGTH);
      for (let i = 0; i < FRAME_LENGTH; i++) {
        frame[i] = frameBytes.readInt16LE(i * 2);
      }

      try {
        const keywordIndex = this.porcupine.process(frame);
        if (keywordIndex >= 0) {
          log.info(`🎯 Porcupine wake word detected! (index=${keywordIndex})`);
          this.emit('wake', {
            keywordIndex,
            timestamp: Date.now(),
          });
        }
      } catch (err) {
        log.error('Porcupine process error:', err.message);
      }
    }
  }

  // ── Cleanup ──
  destroy() {
    if (this.porcupine) {
      try {
        this.porcupine.release();
      } catch { /* ignore */ }
      this.porcupine = null;
      this.initialized = false;
    }
    log.info('Porcupine released');
  }

  disable() {
    this.enabled = false;
  }

  enable() {
    this.enabled = true;
  }
}

export default PorcupineWakeDetector;
