// scripts/generate-acks.js — Generate pre-cached acknowledgment audio files
//
// Uses the project's TTS engine (Telnyx/ElevenLabs/macOS) to synthesize
// short ack phrases and save them to assets/acks/ for instant playback.
//
// Usage: node scripts/generate-acks.js

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

// Load .env before importing config-dependent modules
import 'dotenv/config';

// Now import TTS engine (which reads config)
const { default: TtsEngine } = await import(join(projectRoot, 'src', 'tts', 'tts-engine.js'));

const acks = [
  { text: 'Mm-hmm', file: 'mmhmm.mp3' },
  { text: 'Yeah', file: 'yeah.mp3' },
  { text: 'One sec', file: 'onesec.mp3' },
  { text: 'Let me check', file: 'letmecheck.mp3' },
  { text: 'On it', file: 'onit.mp3' },
  { text: 'Got it', file: 'gotit.mp3' },
  { text: 'Checking', file: 'checking.mp3' },
  { text: 'Pulling that up', file: 'pullingthatup.mp3' },
];

const outDir = join(projectRoot, 'assets', 'acks');
mkdirSync(outDir, { recursive: true });

async function generateAll() {
  const tts = new TtsEngine();
  console.log(`TTS provider: ${tts.provider}`);
  console.log(`Output dir: ${outDir}`);
  console.log('');

  let generated = 0;
  let failed = 0;

  for (const ack of acks) {
    console.log(`Generating: "${ack.text}"`);
    try {
      const result = await tts.synthesize(ack.text, { pace: 'urgent' });
      if (!result) {
        console.error(`  Failed: synthesize returned null`);
        failed++;
        continue;
      }

      const outPath = join(outDir, ack.file);
      // If provider returned aiff (macOS), save with correct extension
      const actualFile = result.format === 'aiff'
        ? ack.file.replace('.mp3', '.aiff')
        : ack.file;
      const actualPath = join(outDir, actualFile);
      writeFileSync(actualPath, result.buffer);
      console.log(`  Saved: ${actualPath} (${(result.buffer.length / 1024).toFixed(1)}KB, ${result.format})`);
      generated++;
    } catch (e) {
      console.error(`  Failed: ${e.message}`);
      failed++;
    }
  }

  console.log('');
  console.log(`Done! Generated: ${generated}, Failed: ${failed}`);
  if (generated === 0) {
    console.error('No acks generated — check TTS config / API keys in .env');
    process.exit(1);
  }
}

generateAll();
