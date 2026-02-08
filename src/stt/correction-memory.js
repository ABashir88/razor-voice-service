// src/stt/correction-memory.js — Auto-correct known Deepgram misheards
//
// Two layers:
//   1. Static corrections: hardcoded list of known misheards (proper nouns, jargon)
//   2. Dynamic corrections: learned from user feedback over time (persisted)
//
// Usage:
//   import { sttCorrections } from './correction-memory.js';
//   const fixed = sttCorrections.correct("raze her what's on my calendar");
//   // → "razor what's on my calendar"

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import makeLogger from '../utils/logger.js';

const log = makeLogger('STTCorrections');

const DATA_DIR = join(process.cwd(), 'data', 'stt');
const CORRECTIONS_FILE = join(DATA_DIR, 'corrections.json');

// ── Static corrections: known Deepgram misheards ──
// These never change — hardcoded from observed misrecognitions.
// Format: regex pattern → replacement string
const STATIC_CORRECTIONS = [
  // Wake word variants (Deepgram frequently mishears "Razor")
  [/\braze her\b/gi, 'razor'],
  [/\braiser\b/gi, 'razor'],
  [/\briser\b/gi, 'razor'],
  [/\bfrazer\b/gi, 'razor'],
  [/\bfraser\b/gi, 'razor'],
  [/\bcaesar\b/gi, 'razor'],
  [/\blazer\b/gi, 'razor'],
  [/\brazer\b/gi, 'razor'],
  [/\brazar\b/gi, 'razor'],
  [/\brizar\b/gi, 'razor'],

  // Company names (Telnyx-specific jargon)
  [/\btell next\b/gi, 'Telnyx'],
  [/\btel next\b/gi, 'Telnyx'],
  [/\btell nyx\b/gi, 'Telnyx'],
  [/\btel nix\b/gi, 'Telnyx'],
  [/\btell nix\b/gi, 'Telnyx'],
  [/\btelonics\b/gi, 'Telnyx'],

  // Sales jargon
  [/\bsales loft\b/gi, 'Salesloft'],
  [/\bsales force\b/gi, 'Salesforce'],
  [/\bcadence\b/gi, 'cadence'],  // Sometimes mis-cased

  // Common misheards
  [/\bpipe line\b/gi, 'pipeline'],
  [/\bcalender\b/gi, 'calendar'],
  [/\bschedual\b/gi, 'schedule'],
];

class CorrectionMemory {
  constructor() {
    this._dynamic = new Map(); // wrong → correct
    this._loaded = false;
  }

  /**
   * Load dynamic corrections from disk.
   */
  load() {
    if (this._loaded) return;
    this._loaded = true;

    if (!existsSync(CORRECTIONS_FILE)) {
      log.info('No dynamic corrections file — starting fresh');
      return;
    }

    try {
      const raw = readFileSync(CORRECTIONS_FILE, 'utf-8');
      const data = JSON.parse(raw);
      if (data.corrections && typeof data.corrections === 'object') {
        for (const [wrong, correct] of Object.entries(data.corrections)) {
          this._dynamic.set(wrong.toLowerCase(), correct);
        }
      }
      log.info(`Loaded ${this._dynamic.size} dynamic corrections`);
    } catch (err) {
      log.warn('Failed to load corrections:', err.message);
    }
  }

  /**
   * Apply all corrections (static + dynamic) to a transcript.
   * @param {string} text — Raw Deepgram transcript
   * @returns {string} — Corrected transcript
   */
  correct(text) {
    if (!text) return text;
    let result = text;

    // Apply static corrections (regex-based)
    for (const [pattern, replacement] of STATIC_CORRECTIONS) {
      result = result.replace(pattern, replacement);
    }

    // Apply dynamic corrections (word-level)
    if (this._dynamic.size > 0) {
      const words = result.split(/\s+/);
      const corrected = words.map(word => {
        const lower = word.toLowerCase().replace(/[.,!?]/g, '');
        const fix = this._dynamic.get(lower);
        if (fix) {
          // Preserve trailing punctuation
          const punct = word.match(/[.,!?]+$/)?.[0] || '';
          return fix + punct;
        }
        return word;
      });
      result = corrected.join(' ');
    }

    if (result !== text) {
      log.debug(`Corrected: "${text}" → "${result}"`);
    }

    return result;
  }

  /**
   * Add a dynamic correction.
   * @param {string} wrong — Misheard word/phrase
   * @param {string} correct — Correct replacement
   */
  addCorrection(wrong, correct) {
    this._dynamic.set(wrong.toLowerCase(), correct);
    this._save();
    log.info(`Added correction: "${wrong}" → "${correct}"`);
  }

  /**
   * Remove a dynamic correction.
   * @param {string} wrong — Key to remove
   */
  removeCorrection(wrong) {
    this._dynamic.delete(wrong.toLowerCase());
    this._save();
  }

  /**
   * Get all dynamic corrections.
   * @returns {Object} — { wrong: correct, ... }
   */
  getAll() {
    return Object.fromEntries(this._dynamic);
  }

  _save() {
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      const data = {
        corrections: Object.fromEntries(this._dynamic),
        updatedAt: new Date().toISOString(),
      };
      writeFileSync(CORRECTIONS_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
      log.warn('Failed to save corrections:', err.message);
    }
  }
}

// Singleton
export const sttCorrections = new CorrectionMemory();
export default sttCorrections;
