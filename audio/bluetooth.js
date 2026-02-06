/**
 * Bluetooth Management — Ortizan X8 Pro connection and audio routing.
 * 
 * Handles:
 *   - Connection verification and reconnection via blueutil
 *   - Audio input/output routing via SwitchAudioSource
 *   - Periodic health monitoring (every 60s)
 *   - Fallback to Mac Mini speakers if Ortizan disconnects
 */
import { execSync } from 'node:child_process';
import { log, logError } from '../lib/log.js';

export class BluetoothManager {
  constructor(config) {
    this.deviceName = config.bluetooth.deviceName;   // "X8 Pro"
    this.macAddress = config.bluetooth.macAddress;    // "1c-2c-e0-05-1a-84"
    this.fallbackOutput = config.bluetooth.fallbackOutput; // "Mac mini Speakers"
    this.outputOverride = config.bluetooth.outputOverride || null; // Override output device
    this.maxRetries = config.bluetooth.maxRetries || 1;
    this.connected = false;
    this.usingFallback = false;
    this._interval = null;
  }

  /**
   * Check if the Ortizan is connected via Bluetooth.
   */
  isConnected() {
    try {
      const result = execSync(`blueutil --is-connected "${this.macAddress}"`, { encoding: 'utf8', timeout: 3000 }).trim();
      if (result === '1') return true;
    } catch {}
    // Fallback: check if audio device is available (blueutil can be wrong)
    try {
      const inputs = execSync('SwitchAudioSource -a -t input', { encoding: 'utf8', timeout: 3000 });
      return inputs.includes(this.deviceName);
    } catch {}
    return false;
  }

  /**
   * Attempt to connect to the Ortizan via Bluetooth.
   */
  connect() {
    try {
      log('🔵', `Connecting to ${this.deviceName}...`);
      // Fire and forget — blueutil --connect can hang on disconnected devices
      try {
        execSync(`blueutil --connect "${this.macAddress}"`, { timeout: 5000 });
      } catch {}
      // Quick check
      for (let i = 0; i < 3; i++) {
        if (this.isConnected()) return true;
        execSync('sleep 1');
      }
      // Also check if audio device appeared (BT might be connected but blueutil disagrees)
      try {
        const inputs = execSync('SwitchAudioSource -a -t input', { encoding: 'utf8' });
        if (inputs.includes(this.deviceName)) return true;
      } catch {}
      return false;
    } catch (err) {
      logError(`Bluetooth connect failed`, err);
      return false;
    }
  }

  /**
   * Set audio routing to use the Ortizan for both input and output.
   */
  setAudioRouting() {
    try {
      // Set input (mic) — always Ortizan
      execSync(`SwitchAudioSource -t input -s "${this.deviceName}"`, { encoding: 'utf8' });
      log('🎤', `Input: ${this.deviceName}`);
    } catch (err) {
      logError('Failed to set audio input', err);
      return false;
    }

    try {
      // Set output — use override if configured, otherwise Ortizan
      const outputDevice = this.outputOverride || this.deviceName;
      execSync(`SwitchAudioSource -t output -s "${outputDevice}"`, { encoding: 'utf8' });
      log('🔊', `Output: ${outputDevice}`);
    } catch (err) {
      logError('Failed to set audio output', err);
      return false;
    }

    return true;
  }

  /**
   * Fall back to Mac Mini built-in speaker for output.
   * Input won't work without the Ortizan mic.
   */
  fallbackToBuiltIn() {
    try {
      execSync(`SwitchAudioSource -t output -s "${this.fallbackOutput}"`, { encoding: 'utf8' });
      this.usingFallback = true;
      log('⚠️', `Fallback: Output → ${this.fallbackOutput}`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Verify current audio routing matches expected devices.
   */
  verifyRouting() {
    try {
      const input = execSync('SwitchAudioSource -c -t input', { encoding: 'utf8' }).trim();
      const output = execSync('SwitchAudioSource -c -t output', { encoding: 'utf8' }).trim();
      return {
        input,
        output,
        inputCorrect: input === this.deviceName,
        outputCorrect: output === this.deviceName || (this.usingFallback && output === this.fallbackOutput),
      };
    } catch {
      return { input: 'unknown', output: 'unknown', inputCorrect: false, outputCorrect: false };
    }
  }

  /**
   * Full startup sequence:
   *   1. Check connection
   *   2. Reconnect if needed (up to maxRetries)
   *   3. Set audio routing
   *   4. Verify
   */
  async initialize() {
    log('🔵', `Initializing Bluetooth: ${this.deviceName} (${this.macAddress})`);

    // Check connection
    if (this.isConnected()) {
      log('✅', `${this.deviceName} connected`);
      this.connected = true;
    } else {
      // Attempt connection
      for (let i = 0; i < this.maxRetries; i++) {
        log('🔄', `Connection attempt ${i + 1}/${this.maxRetries}...`);
        if (this.connect()) {
          this.connected = true;
          log('✅', `${this.deviceName} connected`);
          break;
        }
      }

      if (!this.connected) {
        log('⚠️', `${this.deviceName} not connected after ${this.maxRetries} attempts`);
        this.fallbackToBuiltIn();
        return { ok: false, mic: false, speaker: true, fallback: true };
      }
    }

    // Set audio routing
    const routingOk = this.setAudioRouting();
    if (!routingOk) {
      log('⚠️', 'Audio routing failed');
      return { ok: false, mic: false, speaker: false, fallback: false };
    }

    // Verify
    const routing = this.verifyRouting();
    log('🔍', `Routing: Input=${routing.input}, Output=${routing.output}`);

    return {
      ok: routing.inputCorrect && routing.outputCorrect,
      mic: routing.inputCorrect,
      speaker: routing.outputCorrect,
      fallback: this.usingFallback,
    };
  }

  /**
   * Start periodic monitoring (every 60 seconds).
   * Reconnects if Ortizan disconnects.
   */
  startMonitoring() {
    this._interval = setInterval(() => {
      try {
        if (!this.isConnected()) {
          log('⚠️', `${this.deviceName} disconnected`);
          this.connected = false;

          // Try to reconnect
          if (this.connect()) {
            this.connected = true;
            this.setAudioRouting();
            this.usingFallback = false;
            log('✅', `${this.deviceName} reconnected`);
          } else if (!this.usingFallback) {
            this.fallbackToBuiltIn();
          }
        } else if (!this.connected) {
          // Was disconnected, now back
          this.connected = true;
          this.setAudioRouting();
          this.usingFallback = false;
          log('✅', `${this.deviceName} back online`);
        }
      } catch {}
    }, 60000);
  }

  /**
   * Stop monitoring.
   */
  stopMonitoring() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
  }

  /**
   * Get current status.
   */
  getStatus() {
    return {
      device: this.deviceName,
      mac: this.macAddress,
      connected: this.connected,
      usingFallback: this.usingFallback,
      routing: this.verifyRouting(),
    };
  }
}
