/**
 * Audio Playback — speaker output via afplay.
 * 
 * Feedback loop prevention:
 *   - Notifies wake word listener AND capture module to block during playback
 *   - 300ms reverb buffer after playback ends before unblocking
 */
import { spawn } from 'node:child_process';
import { writeFile, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { log, logError } from '../lib/log.js';

const TMP_DIR = join(tmpdir(), 'razor-voice');
const REVERB_BUFFER_MS = 300;

let playProcess = null;
let speaking = false;

// External block/unblock callbacks — set by main.js
let _onBlock = null;
let _onUnblock = null;

export function isSpeaking() { return speaking; }
export function setBlockCallbacks(onBlock, onUnblock) {
  _onBlock = onBlock;
  _onUnblock = onUnblock;
}

/**
 * Play an MP3 buffer through the speaker.
 * Blocks all mic input during playback.
 */
export async function playAudio(audioBuffer) {
  if (speaking && playProcess) {
    playProcess.kill();
    speaking = false;
    playProcess = null;
  }

  await mkdir(TMP_DIR, { recursive: true });
  const mp3Path = join(TMP_DIR, `tts-${Date.now()}.mp3`);
  await writeFile(mp3Path, audioBuffer);

  // BLOCK all mic input
  _onBlock?.();
  speaking = true;

  return new Promise((resolve) => {
    playProcess = spawn('afplay', [mp3Path]);

    const cleanup = async () => {
      speaking = false;
      playProcess = null;
      try { await unlink(mp3Path); } catch {}

      // Reverb buffer before unblocking
      setTimeout(() => {
        _onUnblock?.();
      }, REVERB_BUFFER_MS);

      resolve();
    };

    playProcess.on('close', cleanup);
    playProcess.on('error', async (err) => {
      logError('Playback error', err);
      await cleanup();
    });
  });
}

/**
 * Stop playback immediately.
 */
export function stopPlayback() {
  if (playProcess) {
    playProcess.kill();
    speaking = false;
    playProcess = null;
    setTimeout(() => _onUnblock?.(), 100);
    log('🔇', 'Playback stopped');
  }
}
