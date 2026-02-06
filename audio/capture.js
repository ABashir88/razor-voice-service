/**
 * Audio Capture — mic input via sox/rec from Ortizan X8 Pro.
 * 
 * Push-to-talk: startRecording() → stopRecording() → returns WAV path.
 * Feedback loop prevention: recording is blocked while speaker is playing.
 */
import { spawn } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { log, logError } from '../lib/log.js';

const TMP_DIR = join(tmpdir(), 'razor-voice');

let recProcess = null;
let currentRecPath = null;
let recording = false;
let _blocked = false;  // Blocked during playback (feedback prevention)

export function isRecording() { return recording; }
export function isBlocked() { return _blocked; }

/**
 * Block recording (called when TTS playback starts).
 * Prevents the mic from picking up speaker output.
 */
export function blockRecording() {
  _blocked = true;
  if (recording) {
    // Kill active recording — it would only capture speaker output
    cancelRecording();
  }
}

/**
 * Unblock recording (called after TTS playback ends + buffer).
 */
export function unblockRecording() {
  _blocked = false;
}

/**
 * Check if an audio input device is available.
 */
export async function checkAudioInput() {
  return new Promise((resolve) => {
    const test = spawn('rec', ['-q', '-c', '1', '-r', '16000', '-b', '16',
      '-t', 'wav', '/dev/null', 'trim', '0', '0.1'],
      { stdio: ['pipe', 'pipe', 'pipe'] });

    let stderr = '';
    test.stderr?.on('data', d => stderr += d.toString());

    test.on('close', (code) => {
      resolve(code === 0
        ? { ok: true }
        : { ok: false, error: stderr.trim() || 'No audio input device' });
    });

    test.on('error', () => {
      resolve({ ok: false, error: 'sox/rec not installed' });
    });

    setTimeout(() => { test.kill(); resolve({ ok: false, error: 'Audio check timed out' }); }, 5000);
  });
}

/**
 * Start recording from the Ortizan X8 Pro mic.
 * Blocked during TTS playback to prevent feedback loop.
 */
export async function startRecording(config) {
  if (recording) return;
  if (_blocked) {
    log('🔇', 'Recording blocked (speaker active)');
    return;
  }

  await mkdir(TMP_DIR, { recursive: true });
  const wavPath = join(TMP_DIR, `rec-${Date.now()}.wav`);
  recording = true;
  currentRecPath = wavPath;

  const maxSecs = config?.audio?.maxRecordSecs || 60;

  recProcess = spawn('rec', [
    '-q',
    '-c', String(config?.audio?.channels || 1),
    '-r', String(config?.audio?.sampleRate || 16000),
    '-b', String(config?.audio?.bitDepth || 16),
    '-t', 'wav',
    wavPath,
    'trim', '0', String(maxSecs),
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  recProcess.on('error', (err) => {
    logError('Recording error', err);
    recording = false;
    recProcess = null;
  });

  recProcess.on('close', () => {
    recording = false;
    recProcess = null;
  });

  log('🎤', 'Recording...');
}

/**
 * Stop recording and return the WAV file path.
 */
export function stopRecording() {
  if (!recording || !recProcess) return Promise.resolve(null);

  return new Promise((resolve) => {
    const wavPath = currentRecPath;

    recProcess.removeAllListeners('close');
    recProcess.on('close', async () => {
      recording = false;
      recProcess = null;
      currentRecPath = null;

      // Verify the file has actual audio content (> 1KB)
      try {
        const info = await stat(wavPath);
        if (info.size < 1024) {
          log('⚠️', 'Audio too short');
          resolve(null);
          return;
        }
      } catch {
        resolve(null);
        return;
      }

      log('🎤', 'Stopped');
      resolve(wavPath);
    });

    recProcess.kill('SIGINT');

    // Fallback: force kill after 2s
    setTimeout(() => {
      if (recording && recProcess) {
        recProcess.kill('SIGKILL');
        recording = false;
        recProcess = null;
        currentRecPath = null;
        resolve(wavPath);
      }
    }, 2000);
  });
}

/**
 * Kill recording without saving (cancel).
 */
export function cancelRecording() {
  if (recProcess) {
    recProcess.kill('SIGKILL');
  }
  recording = false;
  recProcess = null;
  currentRecPath = null;
}
