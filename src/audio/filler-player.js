// src/audio/filler-player.js — Pre-cached filler phrase player
//
// Plays natural thinking sounds ("Let me check...", "One sec...")
// immediately after user finishes speaking, filling dead silence
// while the brain processes. Killed before real TTS starts.
//
// Categories:
//   thinking  — general stall ("Let me check.", "One sec.")
//   data      — data fetch ("Pulling the data.", "Checking your dashboard.")
//   conversation — casual filler ("Hmm.", "Good question.")

import { existsSync, readFileSync } from 'fs';
import { spawn } from 'child_process';
import { join } from 'path';
import { ensureBluetoothOutput } from './bluetooth.js';
import makeLogger from '../utils/logger.js';

const log = makeLogger('FillerPlayer');

const FILLER_DIR = join(process.cwd(), 'assets', 'fillers');
const MANIFEST_PATH = join(FILLER_DIR, 'manifest.json');

class FillerPlayer {
  constructor() {
    this.manifest = {};   // category → [{ text, file }]
    this.ready = false;
    this._process = null; // current afplay process
  }

  /**
   * Load manifest from assets/fillers/manifest.json.
   * Called once at startup.
   */
  async preload() {
    if (!existsSync(MANIFEST_PATH)) {
      log.warn(`Filler manifest missing: ${MANIFEST_PATH}`);
      return;
    }

    try {
      const raw = readFileSync(MANIFEST_PATH, 'utf-8');
      this.manifest = JSON.parse(raw);

      // Verify at least one file actually exists
      let count = 0;
      for (const entries of Object.values(this.manifest)) {
        for (const entry of entries) {
          if (existsSync(join(FILLER_DIR, entry.file))) {
            count++;
          }
        }
      }

      this.ready = count > 0;
      log.info(`Loaded ${count} filler phrases from manifest`);
    } catch (err) {
      log.warn('Failed to load filler manifest:', err.message);
    }
  }

  /**
   * Play a random filler from the given category.
   * Returns the child process (or null if unavailable).
   *
   * @param {'thinking'|'data'|'conversation'} category
   * @returns {import('child_process').ChildProcess|null}
   */
  play(category = 'thinking') {
    if (!this.ready) return null;

    const entries = this.manifest[category] || this.manifest.thinking;
    if (!entries || entries.length === 0) return null;

    const pick = entries[Math.floor(Math.random() * entries.length)];
    const filepath = join(FILLER_DIR, pick.file);

    if (!existsSync(filepath)) {
      log.debug(`Filler file missing: ${pick.file}`);
      return null;
    }

    // Kill any currently playing filler
    this.stop();

    // Ensure BT output before playing
    ensureBluetoothOutput();

    log.debug(`Playing filler: "${pick.text}" (${pick.file})`);
    this._process = spawn('afplay', ['-v', '0.4', filepath], { stdio: 'ignore' });
    this._process.on('close', () => { this._process = null; });
    this._process.on('error', (err) => {
      log.debug('Filler playback error:', err.message);
      this._process = null;
    });

    return this._process;
  }

  /**
   * Stop the currently playing filler immediately.
   */
  stop() {
    if (this._process) {
      try { this._process.kill('SIGKILL'); } catch { /* ignore */ }
      this._process = null;
    }
  }

  get isPlaying() {
    return this._process !== null;
  }
}

// Singleton
export const fillerPlayer = new FillerPlayer();
export default fillerPlayer;
