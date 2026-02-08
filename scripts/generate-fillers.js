// scripts/generate-fillers.js — Generate pre-synthesized filler phrases
// Run once: node scripts/generate-fillers.js
//
// Creates short audio files for "thinking" sounds that play while
// the brain is processing. Eliminates dead silence after user speaks.

import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILLER_DIR = join(__dirname, '..', 'assets', 'fillers');

const FILLERS = {
  thinking: [
    'Let me check.',
    'One sec.',
    'Checking now.',
    'On it.',
    'Pulling that up.',
    'Let me see.',
  ],
  data: [
    'Let me grab those numbers.',
    'Pulling the data.',
    'Checking your dashboard.',
    'One moment.',
  ],
  conversation: [
    'Hmm.',
    'Good question.',
    'Let me think.',
  ],
};

const VOICE = 'Alex'; // Male macOS voice — matches Razor persona

function generate(text, outputPath) {
  execFileSync('say', ['-v', VOICE, '-o', outputPath, text]);
  console.log(`  + ${outputPath.split('/').pop()}: "${text}"`);
}

function main() {
  mkdirSync(FILLER_DIR, { recursive: true });

  const manifest = {};

  for (const [category, phrases] of Object.entries(FILLERS)) {
    console.log(`\nGenerating ${category} fillers...`);
    manifest[category] = [];
    for (let i = 0; i < phrases.length; i++) {
      const filename = `${category}_${i}.aiff`;
      const outputPath = join(FILLER_DIR, filename);
      generate(phrases[i], outputPath);
      manifest[category].push({ text: phrases[i], file: filename });
    }
  }

  const manifestPath = join(FILLER_DIR, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const total = Object.values(manifest).flat().length;
  console.log(`\nManifest: ${manifestPath}`);
  console.log(`Total: ${total} filler phrases generated`);
}

main();
