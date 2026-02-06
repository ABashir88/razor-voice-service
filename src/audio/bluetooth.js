// src/audio/bluetooth.js – Bluetooth reconnection monitor for Ortizan X8 Pro
//
// Uses `blueutil` (brew install blueutil) to:
//   1. Discover the MAC address of the paired device by name
//   2. Poll connection status every BT_RECONNECT_INTERVAL_MS (default 60s)
//   3. Auto-reconnect if disconnected
//   4. Emit events so the pipeline can pause/resume

import { execFile } from 'child_process';
import { promisify } from 'util';
import EventEmitter from 'eventemitter3';
import config from '../config.js';
import makeLogger from '../utils/logger.js';

const exec = promisify(execFile);
const log = makeLogger('BT');

class BluetoothMonitor extends EventEmitter {
  constructor() {
    super();
    this.deviceName = config.bluetooth.deviceName;
    this.macAddress = null;
    this.connected = false;
    this.timer = null;
    this.intervalMs = config.bluetooth.reconnectIntervalMs;
    this._playbackLocked = false; // true while audio is playing — blocks device switching
  }

  // ── Discover MAC from paired devices list ──
  async discoverMac() {
    try {
      const { stdout } = await exec('blueutil', ['--paired', '--format', 'json']);
      const devices = JSON.parse(stdout);

      const target = devices.find(
        (d) => d.name && d.name.toLowerCase().includes(this.deviceName.toLowerCase())
      );

      if (!target) {
        log.error(`Device "${this.deviceName}" not found in paired list. Paired devices:`);
        devices.forEach((d) => log.error(`  • ${d.name} (${d.address})`));
        return null;
      }

      this.macAddress = target.address;
      log.info(`Found ${this.deviceName} → ${this.macAddress}`);
      return this.macAddress;
    } catch (err) {
      log.error('blueutil discovery failed:', err.message);
      log.warn('Make sure blueutil is installed: brew install blueutil');
      return null;
    }
  }

  // ── Check if device is connected ──
  async isConnected() {
    if (!this.macAddress) return false;
    try {
      const { stdout } = await exec('blueutil', ['--is-connected', this.macAddress]);
      return stdout.trim() === '1';
    } catch {
      return false;
    }
  }

  // ── Reconnect the device ──
  async reconnect() {
    if (!this.macAddress) return false;
    try {
      log.warn(`Reconnecting ${this.deviceName}...`);
      await exec('blueutil', ['--connect', this.macAddress]);

      // blueutil --connect returns immediately; wait for actual connection
      for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise((r) => setTimeout(r, 1500));
        if (await this.isConnected()) {
          log.info(`Reconnected ${this.deviceName} ✓`);
          return true;
        }
      }
      log.error(`Failed to reconnect ${this.deviceName} after 10 attempts`);
      return false;
    } catch (err) {
      log.error('Reconnect error:', err.message);
      return false;
    }
  }

  // ── Set macOS audio input to Bluetooth HFP device ──
  async setAudioInput() {
    try {
      // SwitchAudioSource -t input -s "Ortizan X8 Pro"
      await exec('SwitchAudioSource', ['-t', 'input', '-s', this.deviceName]);
      log.info(`Audio input set to "${this.deviceName}"`);
      return true;
    } catch (err) {
      // Try partial match
      try {
        const { stdout } = await exec('SwitchAudioSource', ['-t', 'input', '-a']);
        const sources = stdout.trim().split('\n');
        const match = sources.find((s) =>
          s.toLowerCase().includes(this.deviceName.toLowerCase())
        );
        if (match) {
          await exec('SwitchAudioSource', ['-t', 'input', '-s', match.trim()]);
          log.info(`Audio input set to "${match.trim()}"`);
          return true;
        }
      } catch { /* ignore nested */ }
      log.warn('Could not set audio input via SwitchAudioSource:', err.message);
      return false;
    }
  }

  // ── Set macOS audio output to Bluetooth speaker ──
  async setAudioOutput() {
    try {
      await exec('SwitchAudioSource', ['-t', 'output', '-s', this.deviceName]);
      log.info(`Audio output set to "${this.deviceName}"`);
    } catch {
      try {
        const { stdout } = await exec('SwitchAudioSource', ['-t', 'output', '-a']);
        const sources = stdout.trim().split('\n');
        const match = sources.find((s) =>
          s.toLowerCase().includes(this.deviceName.toLowerCase())
        );
        if (match) {
          await exec('SwitchAudioSource', ['-t', 'output', '-s', match.trim()]);
          log.info(`Audio output set to "${match.trim()}"`);
        } else {
          log.warn(`Could not find "${this.deviceName}" in outputs. Available:`);
          sources.forEach((s) => log.warn(`  • ${s}`));
        }
      } catch (innerErr) {
        log.warn('Could not set audio output:', innerErr.message);
      }
    }
  }

  // ── Get current macOS output device name ──
  async getOutputDevice() {
    try {
      const { stdout } = await exec('SwitchAudioSource', ['-t', 'output', '-c']);
      return stdout.trim();
    } catch (err) {
      log.warn('Could not query output device:', err.message);
      return null;
    }
  }

  // ── Verify output is set to BT speaker, fix if not ──
  async ensureOutputDevice() {
    const current = await this.getOutputDevice();
    if (!current) return false;

    if (current.toLowerCase().includes(this.deviceName.toLowerCase())) {
      log.debug(`Output device OK: "${current}"`);
      return true;
    }

    log.warn(`Output is "${current}", expected "${this.deviceName}" — switching`);
    await this.setAudioOutput();
    return true;
  }

  // ── Pause/resume polling: stops the timer entirely during playback ──
  // A flag alone has a race condition — if poll() is already mid-execution
  // (past the flag check, inside ensureOutputDevice calling SwitchAudioSource),
  // setting a flag won't stop it. Clearing the timer kills any pending poll.
  pausePolling() {
    this._playbackLocked = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    log.debug('BT polling STOPPED (playback)');
  }

  resumePolling() {
    this._playbackLocked = false;
    if (!this.timer && this.macAddress) {
      this.timer = setInterval(() => this.poll(), this.intervalMs);
    }
    log.debug('BT polling RESUMED');
  }

  // ── Single poll cycle ──
  async poll() {
    // Double-check: skip if locked (belt-and-suspenders with timer stop)
    if (this._playbackLocked) return;

    const wasConnected = this.connected;
    this.connected = await this.isConnected();

    if (wasConnected && !this.connected) {
      log.warn(`${this.deviceName} DISCONNECTED`);
      this.emit('disconnected');

      const ok = await this.reconnect();
      if (ok) {
        this.connected = true;
        await this.setAudioInput();
        await this.setAudioOutput();
        this.emit('reconnected');
      }
    } else if (!wasConnected && this.connected) {
      log.info(`${this.deviceName} connected ✓`);
      await this.setAudioInput();
      await this.setAudioOutput();
      this.emit('reconnected');
    } else if (this.connected) {
      // Device stayed connected — verify output hasn't drifted to Mac speakers
      await this.ensureOutputDevice();
    }
  }

  // ── Start monitoring loop ──
  async start() {
    log.info(`Starting Bluetooth monitor for "${this.deviceName}" (poll every ${this.intervalMs / 1000}s)`);

    const mac = await this.discoverMac();
    if (!mac) {
      log.error('Cannot monitor without MAC address. Is the device paired?');
      return false;
    }

    // Initial check
    this.connected = await this.isConnected();
    if (!this.connected) {
      log.warn('Device not connected — attempting initial reconnect...');
      const ok = await this.reconnect();
      this.connected = ok;
    }

    if (this.connected) {
      await this.setAudioInput();
      await this.setAudioOutput();
    }

    // Start polling
    this.timer = setInterval(() => this.poll(), this.intervalMs);
    this.emit(this.connected ? 'reconnected' : 'disconnected');

    return this.connected;
  }

  // ── Stop monitoring ──
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    log.info('Bluetooth monitor stopped');
  }
}

export default BluetoothMonitor;
