// src/utils/test-playback.js – Test TTS + playback + interruption
//
// Synthesizes a test phrase and plays it through Mac speakers.
// During playback, monitors for interruption.
//
// Usage: npm run test:playback

import AudioPlayback from '../audio/playback.js';
import TtsEngine from '../tts/tts-engine.js';
import makeLogger from './logger.js';

const log = makeLogger('PlaybackTest');

async function main() {
  log.info('═══════════════════════════════════════════');
  log.info('  Playback Test');
  log.info('═══════════════════════════════════════════');

  const tts = new TtsEngine();
  const playback = new AudioPlayback();

  playback.on('playback:start', () => log.info('  ▶ Playback started'));
  playback.on('playback:end', () => log.info('  ⏹ Playback ended'));
  playback.on('playback:interrupt', () => log.info('  ⏸ Playback interrupted!'));

  // Test 1: Normal pace
  log.info('\n── Test 1: Normal pace ──');
  try {
    const result = await tts.synthesize(
      'Hello, I am Razor, your voice assistant. How can I help you today?',
      { pace: 'normal' }
    );
    if (result) {
      await playback.play(result.buffer, { pace: 'normal', format: result.format });
    }
  } catch (err) {
    log.error('TTS failed (this is expected if no API key is set):', err.message);
    log.info('Skipping TTS test — generating a test tone instead');

    // Generate a simple sine wave for testing playback
    const tone = generateTestTone(440, 2, 16000); // 440Hz, 2 seconds
    await playback.play(tone, { pace: 'normal', format: 'wav' });
  }

  // Wait between tests
  await new Promise((r) => setTimeout(r, 1000));

  // Test 2: Urgent pace
  log.info('\n── Test 2: Urgent pace (1.15x speed) ──');
  const urgentTone = generateTestTone(523, 1.5, 16000); // C5, 1.5 seconds
  await playback.play(urgentTone, { pace: 'urgent', format: 'wav' });

  await new Promise((r) => setTimeout(r, 1000));

  // Test 3: Calm pace
  log.info('\n── Test 3: Calm pace (0.9x speed) ──');
  const calmTone = generateTestTone(330, 2, 16000); // E4, 2 seconds
  await playback.play(calmTone, { pace: 'calm', format: 'wav' });

  log.info('\n✓ Playback tests complete');
  process.exit(0);
}

// Generate a simple WAV test tone
function generateTestTone(frequency, durationSec, sampleRate) {
  const numSamples = Math.floor(sampleRate * durationSec);
  const pcm = Buffer.alloc(numSamples * 2);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    // Sine wave with fade in/out
    const envelope = Math.min(t * 10, 1, (durationSec - t) * 10);
    const sample = Math.round(Math.sin(2 * Math.PI * frequency * t) * 16000 * envelope);
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2);
  }

  // Build WAV
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
