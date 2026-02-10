#!/usr/bin/env node
/**
 * Visual Cortex Bridge Test Simulator
 *
 * Starts the bridge server and runs a continuous conversation loop.
 * Open razor-sphere.html in a browser to see the visualization.
 *
 * Usage: node scripts/test-bridge-simulator.js
 */

import bridge from '../src/visual-cortex-bridge.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function runCycle(n) {
  console.log(`\n=== Conversation ${n} ===\n`);

  bridge.setState('IDLE');
  await sleep(3000);

  // User speaks
  bridge.setState('LISTENING');
  const listenTimer = setInterval(() => {
    bridge.setEnergy(0.02 + Math.random() * 0.04);
  }, 50);
  await sleep(500);
  bridge.showTranscript('user', 'What are my top priorities today?');
  await sleep(2000);
  clearInterval(listenTimer);
  bridge.setEnergy(0);

  // Brain processing
  bridge.setState('PROCESSING');
  bridge.showTranscript('razor', 'Analyzing calendar and action items...');
  await sleep(2000);

  // Razor speaks
  bridge.setState('SPEAKING');
  let phase = 0;
  const speakTimer = setInterval(() => {
    phase += 0.14;
    const e = 0.05 + Math.sin(phase) * 0.035 + Math.sin(phase * 2.7) * 0.02 + Math.random() * 0.01;
    bridge.setEnergy(e);
  }, 50);
  bridge.showTranscript('razor', 'You have 3 high-priority meetings today. The UnifyGTM demo at 2 PM is your biggest opportunity.');
  await sleep(5000);
  clearInterval(speakTimer);
  bridge.setEnergy(0);

  // Back to idle
  bridge.setState('IDLE');
  await sleep(1000);
  bridge.clearTranscript();
}

bridge.start(3333);
console.log('Open razor-sphere.html in browser to see visualization\n');

await sleep(1000);
let n = 0;
while (true) {
  n++;
  await runCycle(n);
  await sleep(5000);
}
