// src/audio/ack-player.js — Pre-cached acknowledgment audio player
//
// Preloads short ack audio files from assets/acks/ at startup.
// When Razor detects a wake word, plays a random or contextual ack
// immediately (<50ms) so the user gets instant feedback.
//
// Can play directly via playAck() with built-in BT output guarantee,
// or provide file paths for AudioPlayback.playFile().

import { existsSync, readdirSync } from 'fs';
import { spawn } from 'child_process';
import { join } from 'path';
import { ensureBluetoothOutput } from './bluetooth.js';
import config from '../config.js';
import makeLogger from '../utils/logger.js';

const log = makeLogger('AckPlayer');

const ACK_DIR = join(process.cwd(), 'assets', 'acks');

const ACK_FILES = [
  'mmhmm',
  'yeah',
  'onesec',
  'letmecheck',
  'onit',
  'gotit',
  'checking',
  'pullingthatup',
];

// Contextual ack mapping — pick the right tone for the situation
const CONTEXT_MAP = {
  data_query: ['letmecheck', 'checking', 'pullingthatup', 'onesec'],
  quick: ['yeah', 'mmhmm', 'gotit'],
  action: ['onit', 'gotit'],
};

class AckPlayer {
  constructor() {
    this.files = new Map(); // name → filepath
    this.ready = false;
  }

  /**
   * Scan assets/acks/ and register all available ack files.
   * Called once at startup — after this, playback is instant.
   */
  async preload() {
    log.info('Preloading acknowledgment audio...');

    if (!existsSync(ACK_DIR)) {
      log.warn(`Ack directory missing: ${ACK_DIR}`);
      return;
    }

    // Scan for known ack files (support both .mp3 and .aiff)
    for (const name of ACK_FILES) {
      const mp3Path = join(ACK_DIR, `${name}.mp3`);
      const aiffPath = join(ACK_DIR, `${name}.aiff`);

      if (existsSync(mp3Path)) {
        this.files.set(name, mp3Path);
        log.debug(`Loaded: ${name} (mp3)`);
      } else if (existsSync(aiffPath)) {
        this.files.set(name, aiffPath);
        log.debug(`Loaded: ${name} (aiff)`);
      } else {
        log.debug(`Missing: ${name}`);
      }
    }

    this.ready = this.files.size > 0;
    log.info(`Ready with ${this.files.size} acks`);
  }

  /**
   * Get a random ack file path, or null if none available.
   */
  getRandomFile() {
    if (!this.ready || this.files.size === 0) return null;

    const keys = [...this.files.keys()];
    const randomKey = keys[Math.floor(Math.random() * keys.length)];
    return this.files.get(randomKey);
  }

  /**
   * Get a contextual ack file path based on the situation.
   * @param {'data_query'|'quick'|'action'} context
   */
  getContextualFile(context) {
    const options = CONTEXT_MAP[context] || ACK_FILES;
    const available = options.filter(name => this.files.has(name));

    if (available.length === 0) return this.getRandomFile();

    const pick = available[Math.floor(Math.random() * available.length)];
    return this.files.get(pick);
  }

  /**
   * Play an ack with BT output guarantee.
   * Ensures audio goes to X8 Pro before spawning afplay.
   * @param {'data_query'|'quick'|'action'} [context='quick']
   * @returns {import('child_process').ChildProcess|null}
   */
  playAck(context = 'quick') {
    const filepath = this.getContextualFile(context);
    if (!filepath) return null;

    // Verify BT output before every ack — never play on Mac speakers
    ensureBluetoothOutput();

    const rate = config.pacing?.normal?.rate || 1.2;
    const proc = spawn('afplay', [filepath, '-r', String(rate)], { stdio: 'ignore' });
    proc.on('error', (err) => log.debug('Ack playback error:', err.message));
    return proc;
  }
}

// Singleton instance
export const ackPlayer = new AckPlayer();
export default ackPlayer;
