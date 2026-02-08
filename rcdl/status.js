#!/usr/bin/env node

/**
 * Quick RCDL Status Check
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

const RCDL_ROOT = join(process.env.HOME, 'razor-voice-service/rcdl');
const STATE_FILE = join(RCDL_ROOT, 'state.json');
const TASKS_DIR = join(RCDL_ROOT, 'agents/current');

// Load state
let state = { totalCycles: 0, tasksCompleted: 0, status: 'unknown' };
if (existsSync(STATE_FILE)) {
  state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
}

// Count pending tasks
let pendingTasks = 0;
try {
  pendingTasks = readdirSync(TASKS_DIR).filter(f => f.endsWith('.md') && !f.includes('NO_TASKS')).length;
} catch {}

console.log(`
╔═══════════════════════════════════════════════════════════════════════════╗
║                           RCDL STATUS                                     ║
╠═══════════════════════════════════════════════════════════════════════════╣
║                                                                           ║
║  Status:           ${state.status.toUpperCase().padEnd(20)}                         ║
║  Total Cycles:     ${String(state.totalCycles).padEnd(20)}                         ║
║  Tasks Completed:  ${String(state.tasksCompleted).padEnd(20)}                         ║
║  Pending Tasks:    ${String(pendingTasks).padEnd(20)}                         ║
║  Since Last Test:  ${String(state.cyclesSinceHumanCheck || 0).padEnd(5)} cycles                              ║
║                                                                           ║
║  Last Cycle:       ${(state.lastCycleAt || 'Never').slice(0, 19).padEnd(20)}                       ║
║  Last Human Check: ${(state.lastHumanCheckAt || 'Never').slice(0, 19).padEnd(20)}                       ║
║                                                                           ║
╠═══════════════════════════════════════════════════════════════════════════╣
║  PHASES                                                                   ║
║  Phase 3 Humanization:  ${String(state.phases?.phase3?.percent || 0).padStart(3)}%                                 ║
║  Phase 4 Intelligence:  ${String(state.phases?.phase4?.percent || 0).padStart(3)}%                                 ║
║  Phase 5 Learning:      ${String(state.phases?.phase5?.percent || 0).padStart(3)}%                                 ║
║  Phase 6 Autonomy:      ${String(state.phases?.phase6?.percent || 0).padStart(3)}%                                 ║
║                                                                           ║
╚═══════════════════════════════════════════════════════════════════════════╝
`);

if (state.status === 'waiting_for_human') {
  console.log(`
⏸  WAITING FOR HUMAN FEEDBACK

   Run: node ~/razor-voice-service/rcdl/feedback.js
  `);
} else if (pendingTasks > 0) {
  console.log(`
📋 PENDING TASKS: ${pendingTasks}

   View: ls ~/razor-voice-service/rcdl/agents/current/
   Next: cat ~/razor-voice-service/rcdl/agents/current/<file>.md
  `);
} else {
  console.log(`
✓ READY FOR NEXT CYCLE

   Run: node ~/razor-voice-service/rcdl/engine.js
  `);
}
