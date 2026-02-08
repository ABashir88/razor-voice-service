#!/usr/bin/env node

/**
 * Mark an agent's task as complete
 * Usage: node complete.js <agent_number>
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';

const ORCH_ROOT = join(process.env.HOME, 'razor-voice-service/orchestrator');
const STATE_FILE = join(ORCH_ROOT, 'state/state.json');
const TASKS_DIR = join(ORCH_ROOT, 'tasks');

const agentId = process.argv[2];

if (!agentId) {
  console.log('Usage: node complete.js <agent_number>');
  console.log('Example: node complete.js 4');
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

const taskFile = join(TASKS_DIR, `agent${agentId}_${agentName}.md`);

if (existsSync(taskFile)) {
  unlinkSync(taskFile);
  console.log(`✓ Removed task file: agent${agentId}_${agentName}.md`);
}

// Update state
if (existsSync(STATE_FILE)) {
  const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  state.tasksCompleted++;
  state.completedTasks.push({
    agent: agentId,
    completedAt: new Date().toISOString()
  });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  console.log(`✓ Updated state: ${state.tasksCompleted} tasks completed total`);
}

console.log(`\nAgent ${agentId} marked complete. Run orchestrator for next tasks:`);
console.log('  node orchestrator/index.js');
