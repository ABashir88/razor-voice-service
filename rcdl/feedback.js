#!/usr/bin/env node

/**
 * RCDL Human Feedback Tool
 * Captures daily testing feedback and resumes the lifecycle.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import readline from 'readline';

const RCDL_ROOT = join(process.env.HOME, 'razor-voice-service/rcdl');
const STATE_FILE = join(RCDL_ROOT, 'state.json');
const FEEDBACK_DIR = join(RCDL_ROOT, 'feedback');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function ask(question) {
  return new Promise(resolve => rl.question(question, resolve));
}

async function main() {
  console.log(`
╔═══════════════════════════════════════════════════════════════════════════╗
║                         RCDL FEEDBACK TOOL                                ║
╚═══════════════════════════════════════════════════════════════════════════╝
  `);

  // Load state
  let state = { totalCycles: 0 };
  if (existsSync(STATE_FILE)) {
    state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  }

  console.log(`Cycle: ${state.totalCycles}`);
  console.log(`Tasks Completed: ${state.tasksCompleted}`);
  console.log('');

  // Collect feedback
  console.log('─── TESTING FEEDBACK ───\n');

  const worked = await ask('What worked well? \n> ');
  const issues = await ask('\nWhat issues did you find? \n> ');
  const audioQuality = await ask('\nAudio quality (1-5, 5=perfect)? \n> ');
  const responseSpeed = await ask('\nResponse speed (1-5, 5=instant)? \n> ');
  const priority = await ask('\nWhat should be prioritized next? \n> ');
  const logs = await ask('\nPaste any error logs (or press Enter to skip): \n> ');

  // Save feedback
  mkdirSync(FEEDBACK_DIR, { recursive: true });

  const feedback = {
    cycle: state.totalCycles,
    timestamp: new Date().toISOString(),
    worked,
    issues,
    ratings: {
      audioQuality: parseInt(audioQuality) || 3,
      responseSpeed: parseInt(responseSpeed) || 3
    },
    priority,
    logs: logs || null
  };

  const feedbackFile = join(FEEDBACK_DIR, `feedback_${Date.now()}.json`);
  writeFileSync(feedbackFile, JSON.stringify(feedback, null, 2));

  // Update state
  state.lastHumanCheckAt = new Date().toISOString();
  state.cyclesSinceHumanCheck = 0;
  state.status = 'running';
  state.waitingReason = null;
  state.feedbackHistory.push({
    timestamp: new Date().toISOString(),
    summary: issues ? `Issues: ${issues.slice(0, 50)}...` : 'All good'
  });

  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

  console.log(`
╔═══════════════════════════════════════════════════════════════════════════╗
║  ✓ FEEDBACK RECORDED                                                      ║
╠═══════════════════════════════════════════════════════════════════════════╣
║                                                                           ║
║  The lifecycle will now continue.                                        ║
║                                                                           ║
║  Run: node ~/razor-voice-service/rcdl/engine.js                          ║
║                                                                           ║
║  Or to see current tasks:                                                ║
║  ls ~/razor-voice-service/rcdl/agents/current/                           ║
║                                                                           ║
╚═══════════════════════════════════════════════════════════════════════════╝
  `);

  rl.close();
}

main().catch(console.error);
