// src/utils/test-mic.js – Test microphone capture and VAD
//
// Records from the default input device for 10 seconds,
// displays real-time energy levels, and saves a test WAV file.
//
// Usage: npm run test:mic

import AudioCapture from '../audio/capture.js';
import VadEngine from '../vad/vad-engine.js';
import { writeFileSync } from 'fs';
import { join } from 'path';
import makeLogger from './logger.js';

const log = makeLogger('MicTest');

function visualize(rms, threshold) {
  const barLength = Math.min(Math.round(rms * 2000), 50);
  const bar = '█'.repeat(barLength) + '░'.repeat(50 - barLength);
  const marker = rms > threshold ? '🔴 SPEECH' : '⚪ silent';
  return `[${bar}] ${rms.toFixed(5)} ${marker}`;
}

async function main() {
  log.info('═══════════════════════════════════════════');
  log.info('  Mic Test – Recording for 10 seconds');
  log.info('═══════════════════════════════════════════');
  log.info('');

  const capture = new AudioCapture();
  const vad = new VadEngine();
  const chunks = [];
  let speechCount = 0;

  capture.on('data', (pcm) => {
    chunks.push(pcm);

    // Compute energy for visualization
    let sumSq = 0;
    const samples = pcm.length / 2;
    for (let i = 0; i < pcm.length; i += 2) {
      const s = pcm.readInt16LE(i) / 32768;
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / samples);
    process.stdout.write(`\r  ${visualize(rms, vad.energyThreshold)}`);

    vad.process(pcm);
  });

  vad.on('speech:start', () => {
    speechCount++;
    log.info('\n  → Speech detected!');
  });

  vad.on('speech:end', ({ durationMs }) => {
    log.info(`  → Speech ended (${(durationMs / 1000).toFixed(1)}s)`);
  });

  capture.start();

  // Record for 10 seconds
  await new Promise((r) => setTimeout(r, 10000));

  capture.stop();
  log.info('\n');

  // Save WAV
  if (chunks.length > 0) {
    const pcm = Buffer.concat(chunks);
    const wav = buildTestWav(pcm);
    const outPath = join(process.cwd(), 'test-recording.wav');
    writeFileSync(outPath, wav);
    log.info(`Saved: ${outPath} (${(wav.length / 1024).toFixed(0)}KB)`);
  }

  log.info(`Speech segments detected: ${speechCount}`);
  log.info('VAD stats:', vad.getStats());
  process.exit(0);
}

function buildTestWav(pcm, sampleRate = 16000) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

main().catch(console.error);
