#!/usr/bin/env node

/**
 * RAZOR ORCHESTRATOR
 *
 * Assesses project, generates tasks for Claude Code tabs.
 * No API key required — you paste prompts manually.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';

//=== CONFIG ===//

const PROJECT_ROOT = join(process.env.HOME, 'razor-voice-service');
const ORCH_ROOT = join(PROJECT_ROOT, 'orchestrator');
const TASKS_DIR = join(ORCH_ROOT, 'tasks');
const STATE_FILE = join(ORCH_ROOT, 'state/state.json');
const LOG_FILE = join(ORCH_ROOT, 'logs/orchestrator.log');

//=== LOGGING ===//

function log(message) {
  const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
  const line = `[${timestamp}] ${message}`;
  console.log(line);

  try {
    mkdirSync(join(ORCH_ROOT, 'logs'), { recursive: true });
    const existing = existsSync(LOG_FILE) ? readFileSync(LOG_FILE, 'utf8') : '';
    writeFileSync(LOG_FILE, existing + line + '\n');
  } catch {}
}

//=== STATE ===//

function loadState() {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    }
  } catch {}

  return {
    cycle: 0,
    tasksGenerated: 0,
    tasksCompleted: 0,
    lastRun: null,
    completedTasks: [],
    roadmap: {
      phase3: { name: 'Humanization', percent: 60 },
      phase4: { name: 'Intelligence', percent: 15 },
      phase5: { name: 'Learning', percent: 5 },
      phase6: { name: 'Autonomy', percent: 0 }
    }
  };
}

function saveState(state) {
  mkdirSync(join(ORCH_ROOT, 'state'), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

//=== ASSESSMENT ===//

function assess() {
  log('Assessing project state...');

  const assessment = {
    health: checkHealth(),
    phases: checkPhases(),
    tests: runTests(),
    gaps: []
  };

  // Find gaps
  assessment.gaps = findGaps(assessment.phases);

  log(`Health: Brain=${assessment.health.brain ? '✓' : '✗'}, Voice=${assessment.health.voice ? '✓' : '✗'}`);
  log(`Tests: ${assessment.tests.passing} passing, ${assessment.tests.failing} failing`);
  log(`Gaps found: ${assessment.gaps.length}`);

  return assessment;
}

function checkHealth() {
  return {
    brain: isRunning('razor_brain.server'),
    voice: isRunning('node.*index.js')
  };
}

function isRunning(pattern) {
  try {
    execSync(`pgrep -f "${pattern}"`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function checkPhases() {
  const phases = {
    phase3: {
      moodDetector: exists('src/utils/mood-detector.js'),
      naturalizer: exists('src/utils/naturalizer.js'),
      ackPlayer: exists('src/audio/ack-player.js'),
      followUpMode: exists('src/pipeline/follow-up-mode.js'),
      errorHandler: exists('src/utils/error-handler.js')
    },
    phase4: {
      intelligenceDir: exists('src/intelligence'),
      monitor: exists('src/intelligence/monitor.js'),
      alertQueue: exists('src/intelligence/alert-queue.js'),
      signalScorer: exists('src/intelligence/signal-scorer.js'),
      pollers: exists('src/intelligence/pollers')
    },
    phase5: {
      memoryDir: exists('src/memory'),
      workingMemory: exists('src/memory/working-memory.js'),
      longTermMemory: exists('src/memory/long-term-memory.js'),
      memoryIndex: exists('src/memory/index.js')
    },
    phase6: {
      userState: exists('src/state/user-state.js'),
      bargeIn: exists('src/pipeline/barge-in.js')
    }
  };

  return phases;
}

function exists(path) {
  return existsSync(join(PROJECT_ROOT, path));
}

function runTests() {
  try {
    const output = execSync('cd ~/razor-voice-service && npm test 2>&1', {
      encoding: 'utf8',
      timeout: 120000
    });

    const passing = output.match(/(\d+) passing/);
    const failing = output.match(/(\d+) failing/);

    return {
      passing: passing ? parseInt(passing[1]) : 0,
      failing: failing ? parseInt(failing[1]) : 0
    };
  } catch (e) {
    return { passing: 0, failing: 0, error: e.message };
  }
}

function findGaps(phases) {
  const gaps = [];

  // Phase 4: Intelligence (highest priority gap)
  if (!phases.phase4.intelligenceDir) {
    gaps.push({
      priority: 1,
      agent: 4,
      id: 'create_intelligence_dir',
      title: 'Create Intelligence Layer Structure',
      description: 'Create src/intelligence directory and base files'
    });
  } else {
    if (!phases.phase4.monitor) {
      gaps.push({
        priority: 1,
        agent: 4,
        id: 'create_monitor',
        title: 'Create Intelligence Monitor',
        description: 'Build the polling monitor that checks for engagement signals'
      });
    }
    if (!phases.phase4.alertQueue) {
      gaps.push({
        priority: 2,
        agent: 4,
        id: 'create_alert_queue',
        title: 'Create Alert Queue',
        description: 'Build the queue that holds alerts for delivery'
      });
    }
    if (!phases.phase4.signalScorer) {
      gaps.push({
        priority: 2,
        agent: 4,
        id: 'create_signal_scorer',
        title: 'Create Signal Scorer',
        description: 'Build the scoring system for engagement signals'
      });
    }
  }

  // Phase 6: State
  if (!phases.phase6.userState) {
    gaps.push({
      priority: 2,
      agent: 6,
      id: 'create_user_state',
      title: 'Create User State Manager',
      description: 'Build AVAILABLE/IN_CALL/DND state management'
    });
  }
  if (!phases.phase6.bargeIn) {
    gaps.push({
      priority: 3,
      agent: 6,
      id: 'create_barge_in',
      title: 'Create Barge-In Detection',
      description: 'Allow user to interrupt Razor while speaking'
    });
  }

  // Voice improvements (always room to improve)
  try {
    const indexJs = readFileSync(join(PROJECT_ROOT, 'src/index.js'), 'utf8');
    if (!indexJs.includes('ensureBluetoothOutput')) {
      gaps.push({
        priority: 1,
        agent: 1,
        id: 'fix_bluetooth',
        title: 'Fix Bluetooth Audio Switching',
        description: 'Ensure audio always plays on X8 Pro, not Mac speakers'
      });
    }
  } catch {}

  return gaps.sort((a, b) => a.priority - b.priority);
}

//=== TASK GENERATION ===//

function generateTasks(assessment, state) {
  log('Generating tasks...');

  // Clear old tasks
  mkdirSync(TASKS_DIR, { recursive: true });
  const oldTasks = readdirSync(TASKS_DIR).filter(f => f.endsWith('.md'));
  oldTasks.forEach(f => unlinkSync(join(TASKS_DIR, f)));

  const gaps = assessment.gaps;

  if (gaps.length === 0) {
    log('No gaps found — system is optimal!');
    writeNoTasksFile();
    return 0;
  }

  // Group by agent
  const byAgent = {};
  for (const gap of gaps) {
    if (!byAgent[gap.agent]) byAgent[gap.agent] = [];
    byAgent[gap.agent].push(gap);
  }

  // Generate task file for each agent with work
  let tasksGenerated = 0;

  for (const [agentId, agentGaps] of Object.entries(byAgent)) {
    const taskFile = generateAgentTask(parseInt(agentId), agentGaps, state);
    tasksGenerated++;
    log(`Task generated: ${taskFile}`);
  }

  return tasksGenerated;
}

function generateAgentTask(agentId, gaps, state) {
  const agentNames = {
    1: 'Voice',
    2: 'Brain',
    3: 'Integration',
    4: 'Intelligence',
    5: 'Memory',
    6: 'State'
  };

  const agentName = agentNames[agentId];
  const fileName = `agent${agentId}_${agentName.toLowerCase()}.md`;
  const filePath = join(TASKS_DIR, fileName);

  const taskContent = buildTaskPrompt(agentId, agentName, gaps);
  writeFileSync(filePath, taskContent);

  return fileName;
}

function buildTaskPrompt(agentId, agentName, gaps) {
  const prompts = {
    1: buildVoicePrompt,
    2: buildBrainPrompt,
    3: buildIntegrationPrompt,
    4: buildIntelligencePrompt,
    5: buildMemoryPrompt,
    6: buildStatePrompt
  };

  const buildFn = prompts[agentId] || buildGenericPrompt;
  return buildFn(agentId, agentName, gaps);
}

function buildVoicePrompt(agentId, agentName, gaps) {
  return `Read CLAUDE.md.

You are Agent ${agentId}: ${agentName} Agent for Razor.

## YOUR TASKS (Priority Order)

${gaps.map((g, i) => `### Task ${i + 1}: ${g.title}
${g.description}
`).join('\n')}

## SPECIFIC INSTRUCTIONS

### Fix Bluetooth Audio Switching

FILE: src/audio/bluetooth.js

ADD this function:
\`\`\`javascript
export function ensureBluetoothOutput() {
  try {
    const { execSync } = require('child_process');
    const current = execSync('SwitchAudioSource -c -t output', { encoding: 'utf8' }).trim();
    if (!current.includes('X8 Pro')) {
      execSync('SwitchAudioSource -s "X8 Pro" -t output');
      console.log('[BT] Switched to X8 Pro');
    }
  } catch (e) {
    console.warn('[BT] Could not verify output device');
  }
}
\`\`\`

FILE: src/audio/playback.js

IMPORT and CALL ensureBluetoothOutput() at the START of playAudio function.

FILE: src/audio/ack-player.js

IMPORT and CALL ensureBluetoothOutput() before playing ack.

---

AFTER COMPLETION:
1. Verify files modified
2. Say "AGENT ${agentId} COMPLETE"
`;
}

function buildIntelligencePrompt(agentId, agentName, gaps) {
  return `Read CLAUDE.md.

You are Agent ${agentId}: ${agentName} Agent for Razor.

## YOUR MISSION

Build the proactive intelligence layer that monitors for engagement signals and alerts AL.

## YOUR TASKS (Priority Order)

${gaps.map((g, i) => `### Task ${i + 1}: ${g.title}
${g.description}
`).join('\n')}

## ARCHITECTURE

\`\`\`
Every 60 seconds:
├── Poll Salesloft → Get engagement data
├── Compare to previous state → Detect CHANGES
├── Score signals → Prioritize
└── Queue alerts → Deliver when appropriate
\`\`\`

## KEY DATA

- Salesloft user_id: 89440
- Email: alrazi@telnyx.com

## FILES TO CREATE

### 1. src/intelligence/monitor.js

\`\`\`javascript
import makeLogger from '../utils/logger.js';

const log = makeLogger('Intelligence');

class IntelligenceMonitor {
  constructor() {
    this.pollInterval = 60000;
    this.previousState = { opens: {}, clicks: {}, replies: {} };
    this.interval = null;
  }

  start() {
    log.info('Starting monitor');
    this.poll();
    this.interval = setInterval(() => this.poll(), this.pollInterval);
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
  }

  async poll() {
    log.info('Polling...');
    // Implementation: fetch from Salesloft, detect changes, queue alerts
  }
}

export const monitor = new IntelligenceMonitor();
export default monitor;
\`\`\`

### 2. src/intelligence/alert-queue.js

\`\`\`javascript
class AlertQueue {
  constructor() {
    this.queue = [];
    this.delivered = new Set();
  }

  add(signal) {
    const key = \`\${signal.person}-\${signal.type}-\${Math.floor(Date.now() / 3600000)}\`;
    if (this.delivered.has(key)) return;

    this.queue.push(signal);
    this.queue.sort((a, b) => b.score - a.score);
  }

  getNext() { return this.queue.shift(); }
  hasAlerts() { return this.queue.length > 0; }

  formatAlert(signal) {
    const name = signal.person.split(' ')[0];
    switch (signal.type) {
      case 'reply': return \`Heads up — \${name} just replied.\`;
      case 'click': return \`\${name} clicked your link.\`;
      case 'open': return \`\${name} opened your email.\`;
      default: return \`Activity from \${name}.\`;
    }
  }
}

export const alertQueue = new AlertQueue();
export default alertQueue;
\`\`\`

### 3. src/intelligence/signal-scorer.js

\`\`\`javascript
class SignalScorer {
  score(signal) {
    const scores = { reply: 100, click: 75, open: 25 };
    return {
      ...signal,
      score: scores[signal.type] || 10,
      urgency: signal.type === 'reply' ? 'high' : 'medium'
    };
  }
}

export const signalScorer = new SignalScorer();
export default signalScorer;
\`\`\`

### 4. src/intelligence/index.js

\`\`\`javascript
export { monitor } from './monitor.js';
export { alertQueue } from './alert-queue.js';
export { signalScorer } from './signal-scorer.js';
\`\`\`

---

AFTER COMPLETION:
1. Verify all files created
2. Run: ls -la ~/razor-voice-service/src/intelligence/
3. Say "AGENT ${agentId} COMPLETE"
`;
}

function buildStatePrompt(agentId, agentName, gaps) {
  return `Read CLAUDE.md.

You are Agent ${agentId}: ${agentName} Agent for Razor.

## YOUR TASKS (Priority Order)

${gaps.map((g, i) => `### Task ${i + 1}: ${g.title}
${g.description}
`).join('\n')}

## FILES TO CREATE

### 1. src/state/user-state.js

\`\`\`javascript
import makeLogger from '../utils/logger.js';

const log = makeLogger('UserState');

class UserState {
  constructor() {
    this.state = 'AVAILABLE'; // AVAILABLE | IN_CALL | FOCUSED | DND
    this.alertQueue = [];
  }

  setState(newState) {
    log.info(\`\${this.state} → \${newState}\`);
    this.state = newState;
  }

  getState() { return this.state; }
  isAvailable() { return this.state === 'AVAILABLE'; }
  canReceiveAlerts() { return this.state !== 'DND'; }

  parseCommand(text) {
    const lower = text.toLowerCase();
    if (lower.includes("i'm on a call") || lower.includes("in a meeting")) {
      return { newState: 'IN_CALL', response: "Got it. I'll hold alerts." };
    }
    if (lower.includes("i'm back") || lower.includes("i'm done")) {
      return { newState: 'AVAILABLE', response: "Welcome back." };
    }
    if (lower.includes("do not disturb") || lower.includes("dnd")) {
      return { newState: 'DND', response: "Do not disturb. I'll be silent." };
    }
    return null;
  }
}

export const userState = new UserState();
export default userState;
\`\`\`

### 2. src/pipeline/barge-in.js

\`\`\`javascript
class BargeInDetector {
  constructor() {
    this.enabled = false;
    this.onBargeIn = null;
  }

  enable(callback) {
    this.enabled = true;
    this.onBargeIn = callback;
  }

  disable() {
    this.enabled = false;
    this.onBargeIn = null;
  }

  onSpeechDetected() {
    if (this.enabled && this.onBargeIn) {
      this.onBargeIn();
      this.disable();
    }
  }
}

export const bargeIn = new BargeInDetector();
export default bargeIn;
\`\`\`

---

AFTER COMPLETION:
1. Create all files
2. Say "AGENT ${agentId} COMPLETE"
`;
}

function buildBrainPrompt(agentId, agentName, gaps) {
  return `Read CLAUDE.md.

You are Agent ${agentId}: ${agentName} Agent for Razor.

## YOUR TASKS

${gaps.map((g, i) => `### Task ${i + 1}: ${g.title}
${g.description}
`).join('\n')}

---

AFTER COMPLETION: Say "AGENT ${agentId} COMPLETE"
`;
}

function buildIntegrationPrompt(agentId, agentName, gaps) {
  return buildBrainPrompt(agentId, agentName, gaps);
}

function buildMemoryPrompt(agentId, agentName, gaps) {
  return `Read CLAUDE.md.

You are Agent ${agentId}: ${agentName} Agent for Razor.

Memory system is already built (Phase 3 Complete per CLAUDE.md).

## YOUR TASK

Audit memory integration:
1. Check memory is called in src/index.js
2. Check context sent to brain
3. Report any gaps

Run:
\`\`\`bash
grep -r "memory\\." ~/razor-voice-service/src/index.js | head -10
grep -r "getContext" ~/razor-voice-service/src/ | head -10
\`\`\`

---

AFTER COMPLETION: Say "AGENT ${agentId} COMPLETE"
`;
}

function buildGenericPrompt(agentId, agentName, gaps) {
  return `Read CLAUDE.md.

You are Agent ${agentId}: ${agentName} Agent for Razor.

## YOUR TASKS

${gaps.map((g, i) => `### Task ${i + 1}: ${g.title}
${g.description}
`).join('\n')}

---

AFTER COMPLETION: Say "AGENT ${agentId} COMPLETE"
`;
}

function writeNoTasksFile() {
  const content = `# No Tasks Needed

All gaps have been addressed! System is optimal.

## What You Can Do

1. **Test Razor** — Run voice commands and provide feedback
2. **Add features** — Tell the orchestrator what to build next
3. **Fix issues** — Report any bugs you find

Run orchestrator again after testing: \`node orchestrator/index.js\`
`;

  writeFileSync(join(TASKS_DIR, 'NO_TASKS.md'), content);
}

//=== STATUS DISPLAY ===//

function printStatus(state, assessment, tasksGenerated) {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                    RAZOR ORCHESTRATOR                         ║
╠═══════════════════════════════════════════════════════════════╣
║  Cycle: ${String(state.cycle).padEnd(10)}  Tasks Generated: ${String(state.tasksGenerated).padEnd(10)}    ║
║  Completed: ${String(state.tasksCompleted).padEnd(10)}                                  ║
╠═══════════════════════════════════════════════════════════════╣
║  HEALTH                                                       ║
║  Brain Server:  ${assessment.health.brain ? '✅ Running' : '❌ Stopped'}                              ║
║  Voice Service: ${assessment.health.voice ? '✅ Running' : '❌ Stopped'}                              ║
║  Tests:         ${String(assessment.tests.passing).padEnd(3)} passing, ${String(assessment.tests.failing).padEnd(3)} failing          ║
╠═══════════════════════════════════════════════════════════════╣
║  TASKS GENERATED THIS CYCLE: ${String(tasksGenerated).padEnd(3)}                          ║
╚═══════════════════════════════════════════════════════════════╝
  `);

  if (tasksGenerated > 0) {
    console.log(`
┌─────────────────────────────────────────────────────────────────┐
│  NEXT STEPS                                                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. Open Claude Code tabs (one per agent with tasks)           │
│                                                                 │
│  2. For each task file, copy and paste into Claude Code:       │
│                                                                 │`);

    const taskFiles = readdirSync(TASKS_DIR).filter(f => f.endsWith('.md') && f !== 'NO_TASKS.md');
    for (const file of taskFiles) {
      console.log(`│     cat ~/razor-voice-service/orchestrator/tasks/${file}`.padEnd(66) + '│');
    }

    console.log(`│                                                                 │
│  3. When agent says "COMPLETE", mark it done:                  │
│     node orchestrator/complete.js <agent_number>              │
│                                                                 │
│  4. Run orchestrator again to get next tasks:                  │
│     node orchestrator/index.js                                 │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
    `);
  }
}

//=== MAIN ===//

function main() {
  console.log('Starting Razor Orchestrator...\n');

  // Load state
  const state = loadState();
  state.cycle++;
  state.lastRun = new Date().toISOString();

  // Assess
  const assessment = assess();

  // Generate tasks
  const tasksGenerated = generateTasks(assessment, state);
  state.tasksGenerated += tasksGenerated;

  // Save state
  saveState(state);

  // Print status
  printStatus(state, assessment, tasksGenerated);
}

main();
