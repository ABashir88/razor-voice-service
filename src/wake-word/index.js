// src/wake-word/index.js – Wake word strategy selector
//
// Automatically chooses between:
//   1. Porcupine (if PORCUPINE_ACCESS_KEY is set) — low-latency, on-device
//   2. Transcript fallback (VAD → Deepgram STT → check for "razor") — works now
//
// The pipeline interacts with this module uniformly regardless of which
// strategy is active. Both emit 'wake' events with compatible payloads.

import config from '../config.js';
import PorcupineWakeDetector from './porcupine-detector.js';
import TranscriptWakeDetector from './transcript-detector.js';
import makeLogger from '../utils/logger.js';

const log = makeLogger('WakeWord');

async function createWakeWordDetector() {
  if (config.wakeWord.usePorcupine) {
    log.info('Strategy: Porcupine (on-device wake word detection)');
    const detector = new PorcupineWakeDetector();
    const ok = await detector.init();

    if (ok) {
      return { type: 'porcupine', detector };
    }

    log.warn('Porcupine init failed — falling back to transcript detection');
  }

  log.info('Strategy: VAD + Deepgram transcript (fallback)');
  const detector = new TranscriptWakeDetector();
  return { type: 'transcript', detector };
}

export { createWakeWordDetector, PorcupineWakeDetector, TranscriptWakeDetector };
