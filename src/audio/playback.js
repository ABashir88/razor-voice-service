// src/audio/playback.js – TTS audio playback via afplay (Bluetooth speaker)
//
// Features:
//   • Plays WAV/MP3 through X8 Pro Bluetooth speaker using afplay
//   • Device enforcement loop: forces output to X8 Pro every 500ms during playback
//   • Interruption handling: kill afplay immediately on interrupt signal
//   • Feedback loop prevention: signals mic mute/unmute around playback
//   • Dynamic pacing: adjusts afplay rate parameter
//
// Emits:
//   'playback:start'    → playback started, mic should mute
//   'playback:end'      → playback finished naturally
//   'playback:interrupt' → playback killed by interruption
//   'playback:error'    → playback error

import { spawn, execFile } from 'child_process';
import { writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { promisify } from 'util';
import EventEmitter from 'eventemitter3';
import { ensureBluetoothOutput } from './bluetooth.js';
import config from '../config.js';
import makeLogger from '../utils/logger.js';

const execFileAsync = promisify(execFile);
const log = makeLogger('Playback');

class AudioPlayback extends EventEmitter {
  constructor() {
    super();
    this.process = null;
    this.playing = false;
    this.currentFile = null;
    this._deviceEnforcer = null; // interval that forces BT output during playback
  }

  // ── Force macOS audio output to BT speaker, wait for settle, verify ──
  async _forceOutputDevice() {
    const target = config.bluetooth.deviceName;
    try {
      await execFileAsync('SwitchAudioSource', ['-t', 'output', '-s', target]);
      await new Promise((r) => setTimeout(r, 80));

      const { stdout } = await execFileAsync('SwitchAudioSource', ['-t', 'output', '-c']);
      const actual = stdout.trim();

      if (!actual.toLowerCase().includes(target.toLowerCase())) {
        log.warn(`Device mismatch: "${actual}" — retrying switch to "${target}"`);
        await execFileAsync('SwitchAudioSource', ['-t', 'output', '-s', target]);
        await new Promise((r) => setTimeout(r, 80));
      }

      log.info(`Device BEFORE play: ${actual}`);
    } catch (err) {
      log.warn('Could not set output device:', err.message);
    }
  }

  // ── Force output back to BT speaker after playback ──
  async _restoreOutputDevice() {
    const target = config.bluetooth.deviceName;
    try {
      await execFileAsync('SwitchAudioSource', ['-t', 'output', '-s', target]);
      await new Promise((r) => setTimeout(r, 100));

      const { stdout } = await execFileAsync('SwitchAudioSource', ['-t', 'output', '-c']);
      const actual = stdout.trim();
      log.info(`Device AFTER play: ${actual}`);
    } catch (err) {
      log.warn('Could not restore output device:', err.message);
    }
  }

  // ── Device enforcement: re-forces X8 Pro every 200ms while afplay is running ──
  // afplay follows the macOS system default output device. If macOS switches it
  // mid-stream (BT codec renegotiation, power management, etc.), audio jumps to
  // Mac mini speakers. This loop forces it back within 200ms.
  _startDeviceEnforcer() {
    const target = config.bluetooth.deviceName;
    this._deviceEnforcer = setInterval(() => {
      // Fire-and-forget — don't block the event loop, don't care if it fails once
      execFileAsync('SwitchAudioSource', ['-t', 'output', '-s', target]).catch(() => {});
    }, 200);
  }

  _stopDeviceEnforcer() {
    if (this._deviceEnforcer) {
      clearInterval(this._deviceEnforcer);
      this._deviceEnforcer = null;
    }
  }

  // ── Play an audio buffer (WAV or MP3 bytes) ──
  async play(audioBuffer, { pace = 'normal', format = 'wav' } = {}) {
    if (this.playing) {
      await this.interrupt();
    }

    // Write buffer to temp file
    const filename = `razor-tts-${randomUUID().slice(0, 8)}.${format}`;
    this.currentFile = join(tmpdir(), filename);

    try {
      await writeFile(this.currentFile, audioBuffer);
    } catch (err) {
      log.error('Failed to write temp audio file:', err.message);
      this.emit('playback:error', err);
      return;
    }

    // Force output to BT speaker and wait 100ms for macOS to settle
    await this._forceOutputDevice();

    // Build afplay command with rate adjustment for dynamic pacing
    const paceConfig = config.pacing[pace] || config.pacing.normal;
    const args = [this.currentFile, '-r', String(paceConfig.rate)];

    return new Promise((resolve) => {
      log.info(`Playing audio: ${filename} (pace=${pace}, rate=${paceConfig.rate})`);

      this.playing = true;
      this.emit('playback:start');

      this.process = spawn('afplay', args, { stdio: 'ignore' });

      // Start device enforcement loop — forces X8 Pro every 200ms during playback
      this._startDeviceEnforcer();

      this.process.on('close', async (code, signal) => {
        this._stopDeviceEnforcer();
        this.playing = false;
        this.process = null;

        // Clean up temp file
        try {
          await unlink(this.currentFile);
        } catch { /* ignore */ }
        this.currentFile = null;

        // macOS reclaims default output when afplay exits on BT — force it back
        await this._restoreOutputDevice();

        if (signal === 'SIGKILL' || signal === 'SIGTERM') {
          log.info('Playback interrupted');
          this.emit('playback:interrupt');
        } else if (code === 0) {
          log.info('Playback finished');
          this.emit('playback:end');
        } else {
          log.warn(`afplay exited with code ${code}`);
          this.emit('playback:error', new Error(`afplay exit code ${code}`));
        }

        resolve();
      });

      this.process.on('error', (err) => {
        this._stopDeviceEnforcer();
        this.playing = false;
        this.process = null;
        log.error('afplay spawn error:', err.message);
        this.emit('playback:error', err);
        resolve();
      });
    });
  }

  // ── Play a file directly without emitting events (for quick acks) ──
  playFile(filepath) {
    // Ensure BT output before playing — prevents ack on Mac mini speakers
    // ensureBluetoothOutput() now verifies + retries the switch
    ensureBluetoothOutput();

    const paceConfig = config.pacing.normal || { rate: 1.2 };
    const proc = spawn('afplay', [filepath, '-r', String(paceConfig.rate)], { stdio: 'ignore' });
    proc.on('error', (err) => log.debug('Quick playback error:', err.message));
    return proc;
  }

  // ── Interrupt current playback immediately ──
  async interrupt() {
    if (!this.playing || !this.process) return false;

    log.warn('Interrupting playback (kill SIGKILL)');
    this._stopDeviceEnforcer();

    try {
      this.process.kill('SIGKILL');
    } catch (err) {
      log.warn('Kill error (process may have already exited):', err.message);
    }

    await new Promise((r) => setTimeout(r, 50));
    return true;
  }

  get isPlaying() {
    return this.playing;
  }
}

export default AudioPlayback;
