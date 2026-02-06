// src/utils/test-bluetooth.js – Test Bluetooth connection to Ortizan X8 Pro
//
// Usage: npm run test:bluetooth

import BluetoothMonitor from '../audio/bluetooth.js';
import makeLogger from './logger.js';

const log = makeLogger('BTTest');

async function main() {
  log.info('═══════════════════════════════════════════');
  log.info('  Bluetooth Connection Test');
  log.info('═══════════════════════════════════════════');

  const bt = new BluetoothMonitor();

  // Step 1: Discover
  log.info('\n── Step 1: Discover paired devices ──');
  const mac = await bt.discoverMac();
  if (!mac) {
    log.error('Device not found. Make sure it is paired in System Settings > Bluetooth');
    process.exit(1);
  }

  // Step 2: Check connection
  log.info('\n── Step 2: Check connection status ──');
  const connected = await bt.isConnected();
  log.info(`Connected: ${connected ? 'YES ✓' : 'NO ✗'}`);

  // Step 3: Reconnect if needed
  if (!connected) {
    log.info('\n── Step 3: Attempting reconnect ──');
    const ok = await bt.reconnect();
    log.info(`Reconnect: ${ok ? 'SUCCESS ✓' : 'FAILED ✗'}`);
  }

  // Step 4: Set audio routing
  log.info('\n── Step 4: Set audio routing ──');
  await bt.setAudioInput();
  await bt.setAudioOutput();

  // Step 5: Show current audio devices
  log.info('\n── Step 5: Current audio devices ──');
  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const exec = promisify(execFile);

    const { stdout: inputs } = await exec('SwitchAudioSource', ['-t', 'input', '-a']);
    const { stdout: currentIn } = await exec('SwitchAudioSource', ['-t', 'input', '-c']);
    log.info('Input devices:');
    inputs.trim().split('\n').forEach((d) => {
      const marker = d.trim() === currentIn.trim() ? ' ← ACTIVE' : '';
      log.info(`  ${d}${marker}`);
    });

    const { stdout: outputs } = await exec('SwitchAudioSource', ['-t', 'output', '-a']);
    const { stdout: currentOut } = await exec('SwitchAudioSource', ['-t', 'output', '-c']);
    log.info('Output devices:');
    outputs.trim().split('\n').forEach((d) => {
      const marker = d.trim() === currentOut.trim() ? ' ← ACTIVE' : '';
      log.info(`  ${d}${marker}`);
    });
  } catch (err) {
    log.warn('SwitchAudioSource not available:', err.message);
    log.info('Install: brew install switchaudio-osx');
  }

  log.info('\n✓ Bluetooth test complete');
  process.exit(0);
}

main().catch(console.error);
