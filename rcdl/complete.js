#!/usr/bin/env node

/**
 * Mark an agent's task as complete
 * Usage: node complete.js <agent_number>
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync } from 'fs';
import { join } from 'path';

const RCDL_ROOT = join(process.env.HOME, 'razor-voice-service/rcdl');
const STATE_FILE = join(RCDL_ROOT, 'state.json');
const TASKS_DIR = join(RCDL_ROOT, 'agents/current');

const agentId = process.argv[2];

if (!agentId) {
  console.log(`
Usage: node complete.js <agent_number>

Examples:
  node complete.js 1   # Mark Voice agent complete
  node complete.js 4   # Mark Intelligence agent complete

Agent Numbers:
  1 = Voice
  2 = Brain
  3 = Integration
  4 = Intelligence
  5 = Memory
  6 = State
  `);
  process.exit(1);
}

const agentNames = {
  1: 'voice',
  2: 'brain',
  3: 'integration',
  4: 'intelligence',
  5: 'memory',
  6: 'state'
};

const agentName = agentNames[agentId];
if (!agentName) {
  console.log('Invalid agent number. Use 1-6.');
  process.exit(1);
}

// Find and remove task file
const taskFiles = readdirSync(TASKS_DIR).filter(f => f.startsWith(`agent${agentId}_`));
for (const file of taskFiles) {
  unlinkSync(join(TASKS_DIR, file));
  console.log(`✓ Removed: ${file}`);
}

// Update state
if (existsSync(STATE_FILE)) {
  const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  state.tasksCompleted++;
  state.agentStats[agentId].tasksCompleted++;
  state.agentStats[agentId].lastTask = new Date().toISOString();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  console.log(`✓ Stats updated: ${state.tasksCompleted} total tasks completed`);
}

console.log(`
╔═══════════════════════════════════════════════════════════════╗
║  Agent ${agentId} (${agentName.toUpperCase()}) marked COMPLETE                     ║
╠═══════════════════════════════════════════════════════════════╣
║                                                               ║
║  Next steps:                                                  ║
║  1. Continue to next task (if any pending)                   ║
║  2. Or run engine for next cycle:                            ║
║     node ~/razor-voice-service/rcdl/engine.js               ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
`);
