// scripts/generate-fillers.js — Generate filler phrases using Telnyx TTS
// Run once: node scripts/generate-fillers.js
//
// Uses the SAME Telnyx voice (Telnyx.Natural.armon) as real responses
// so fillers and responses sound like the same person. No more Frankenstein.
//
// Requires: TELNYX_API_KEY in environment

import { mkdirSync, writeFileSync, readdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILLER_DIR = join(__dirname, '..', 'assets', 'fillers');

const FILLERS = {
  thinking: [
    'Let me check.',
    'One sec.',
    'On it.',
    'Checking.',
    'Hmm, let me see.',
  ],
  data: [
    'Pulling that up.',
    'Grabbing those numbers.',
    'One moment.',
  ],
  conversation: [
    'Hmm.',
    'Good question.',
    'Let me think.',
  ],
};

const VOICE = 'Telnyx.Natural.armon';
const ENDPOINT = 'https://api.telnyx.com/v2/text-to-speech/speech';

async function synthesize(text, apiKey) {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text, voice: VOICE }),
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Telnyx TTS ${response.status}: ${errText}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

async function main() {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) {
    console.error('ERROR: TELNYX_API_KEY not set in environment');
    process.exit(1);
  }

  // Clean old files (.aiff from macOS say, .mp3 from previous runs)
  mkdirSync(FILLER_DIR, { recursive: true });
  for (const file of readdirSync(FILLER_DIR)) {
    if (file.endsWith('.aiff') || file.endsWith('.mp3')) {
      rmSync(join(FILLER_DIR, file), { force: true });
    }
  }

  console.log(`Voice: ${VOICE}`);
  console.log(`Endpoint: ${ENDPOINT}\n`);

  const manifest = {};

  for (const [category, phrases] of Object.entries(FILLERS)) {
    console.log(`Generating ${category} fillers...`);
    manifest[category] = [];
    for (let i = 0; i < phrases.length; i++) {
      const filename = `${category}_${i}.mp3`;
      const outputPath = join(FILLER_DIR, filename);
      try {
        const buffer = await synthesize(phrases[i], apiKey);
        writeFileSync(outputPath, buffer);
        const sizeKB = (buffer.length / 1024).toFixed(1);
        console.log(`  + ${filename}: "${phrases[i]}" (${sizeKB}KB)`);
        manifest[category].push({ text: phrases[i], file: filename });
      } catch (err) {
        console.error(`  ✗ ${filename}: ${err.message}`);
      }
    }
  }

  const manifestPath = join(FILLER_DIR, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const total = Object.values(manifest).flat().length;
  console.log(`\nManifest: ${manifestPath}`);
  console.log(`Total: ${total} filler phrases (format: mp3, voice: ${VOICE})`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
