#!/usr/bin/env node

/**
 * RAZOR CONTINUOUS DEVELOPMENT LIFECYCLE (RCDL)
 *
 * The infinite development loop.
 * Builds non-stop. Pauses for daily human testing.
 * Incorporates feedback. Evolves forever.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';

//=== CONFIGURATION ===//

const CONFIG = {
  projectRoot: join(process.env.HOME, 'razor-voice-service'),
  rcdlRoot: join(process.env.HOME, 'razor-voice-service/rcdl'),

  // Cycle settings
  cyclesBeforeHumanCheck: 10,      // Pause after this many build cycles
  minHoursBetweenTests: 8,         // Minimum hours between human testing requests

  // Agents
  agents: {
    1: { name: 'Voice', domain: 'STT, TTS, wake word, Bluetooth, audio' },
    2: { name: 'Brain', domain: 'LLM, prompts, intent, coaching' },
    3: { name: 'Integration', domain: 'Salesforce, Salesloft, Gmail, Fellow' },
    4: { name: 'Intelligence', domain: 'Monitoring, alerts, signals' },
    5: { name: 'Memory', domain: 'Context, persistence, learning' },
    6: { name: 'State', domain: 'Pipeline, user state, barge-in' }
  }
};

//=== FILE PATHS ===//

const PATHS = {
  state: join(CONFIG.rcdlRoot, 'state.json'),
  feedback: join(CONFIG.rcdlRoot, 'feedback'),
  cycles: join(CONFIG.rcdlRoot, 'cycles'),
  agents: join(CONFIG.rcdlRoot, 'agents'),
  milestones: join(CONFIG.rcdlRoot, 'milestones'),
  logs: join(CONFIG.rcdlRoot, 'logs'),
  currentTasks: join(CONFIG.rcdlRoot, 'agents/current')
};

//=== LOGGING ===//

function log(level, message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
  console.log(line);

  try {
    mkdirSync(PATHS.logs, { recursive: true });
    const logFile = join(PATHS.logs, `rcdl-${timestamp.split('T')[0]}.log`);
    const existing = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
    writeFileSync(logFile, existing + line + '\n');
  } catch {}
}

const logger = {
  info: (msg) => log('info', msg),
  warn: (msg) => log('warn', msg),
  error: (msg) => log('error', msg),
  milestone: (msg) => log('milestone', `🎯 ${msg}`)
};

//=== STATE MANAGEMENT ===//

class RCDLState {
  constructor() {
    this.load();
  }

  getDefault() {
    return {
      // Lifecycle tracking
      totalCycles: 0,
      currentSession: 0,
      cyclesSinceHumanCheck: 0,

      // Time tracking
      startedAt: new Date().toISOString(),
      lastCycleAt: null,
      lastHumanCheckAt: null,
      totalBuildTimeHours: 0,

      // Task tracking
      tasksGenerated: 0,
      tasksCompleted: 0,
      tasksFailed: 0,

      // Phase tracking
      currentPhase: 'phase4',  // phase3 complete per CLAUDE.md
      phases: {
        phase1: { name: 'Foundation', percent: 100, completedAt: '2025-02-01' },
        phase2: { name: 'Functionality', percent: 100, completedAt: '2025-02-04' },
        phase3: { name: 'Humanization', percent: 85, completedAt: null },
        phase4: { name: 'Intelligence', percent: 15, completedAt: null },
        phase5: { name: 'Learning', percent: 5, completedAt: null },
        phase6: { name: 'Autonomy', percent: 0, completedAt: null }
      },

      // Agent tracking
      agentStats: {
        1: { tasksCompleted: 0, lastTask: null },
        2: { tasksCompleted: 0, lastTask: null },
        3: { tasksCompleted: 0, lastTask: null },
        4: { tasksCompleted: 0, lastTask: null },
        5: { tasksCompleted: 0, lastTask: null },
        6: { tasksCompleted: 0, lastTask: null }
      },

      // Feedback history
      feedbackHistory: [],

      // Current status
      status: 'running',  // running | waiting_for_human | paused
      waitingReason: null,

      // Milestones achieved
      milestones: []
    };
  }

  load() {
    try {
      mkdirSync(CONFIG.rcdlRoot, { recursive: true });
      if (existsSync(PATHS.state)) {
        this.data = JSON.parse(readFileSync(PATHS.state, 'utf8'));
        logger.info(`State loaded: ${this.data.totalCycles} total cycles`);
      } else {
        this.data = this.getDefault();
        this.save();
        logger.info('New RCDL state initialized');
      }
    } catch (e) {
      logger.error(`State load error: ${e.message}`);
      this.data = this.getDefault();
    }
  }

  save() {
    writeFileSync(PATHS.state, JSON.stringify(this.data, null, 2));
  }

  incrementCycle() {
    this.data.totalCycles++;
    this.data.currentSession++;
    this.data.cyclesSinceHumanCheck++;
    this.data.lastCycleAt = new Date().toISOString();
    this.save();
  }

  recordTaskComplete(agentId, taskName) {
    this.data.tasksCompleted++;
    this.data.agentStats[agentId].tasksCompleted++;
    this.data.agentStats[agentId].lastTask = taskName;
    this.save();
  }

  recordHumanCheck(feedback) {
    this.data.lastHumanCheckAt = new Date().toISOString();
    this.data.cyclesSinceHumanCheck = 0;
    this.data.feedbackHistory.push({
      timestamp: new Date().toISOString(),
      ...feedback
    });
    this.save();
  }

  updatePhase(phase, percent) {
    if (this.data.phases[phase]) {
      this.data.phases[phase].percent = percent;
      if (percent >= 100 && !this.data.phases[phase].completedAt) {
        this.data.phases[phase].completedAt = new Date().toISOString();
        this.addMilestone(`${this.data.phases[phase].name} phase completed!`);
      }
      this.save();
    }
  }

  addMilestone(description) {
    this.data.milestones.push({
      timestamp: new Date().toISOString(),
      cycle: this.data.totalCycles,
      description
    });
    logger.milestone(description);
    this.save();
  }

  setStatus(status, reason = null) {
    this.data.status = status;
    this.data.waitingReason = reason;
    this.save();
  }

  needsHumanCheck() {
    // Check if enough cycles have passed
    if (this.data.cyclesSinceHumanCheck >= CONFIG.cyclesBeforeHumanCheck) {
      return true;
    }

    // Check if enough time has passed since last check
    if (this.data.lastHumanCheckAt) {
      const hoursSince = (Date.now() - new Date(this.data.lastHumanCheckAt).getTime()) / 3600000;
      if (hoursSince >= CONFIG.minHoursBetweenTests && this.data.cyclesSinceHumanCheck >= 5) {
        return true;
      }
    }

    return false;
  }
}

//=== PROJECT ASSESSOR ===//

class ProjectAssessor {
  assess() {
    logger.info('Assessing project state...');

    return {
      timestamp: new Date().toISOString(),
      health: this.checkHealth(),
      tests: this.runTests(),
      phases: this.assessPhases(),
      gaps: this.findGaps(),
      recentFeedback: this.getRecentFeedback()
    };
  }

  checkHealth() {
    return {
      brain: this.isRunning('razor_brain.server'),
      voice: this.isRunning('node.*index.js'),
      gitClean: this.isGitClean()
    };
  }

  isRunning(pattern) {
    try {
      execSync(`pgrep -f "${pattern}"`, { stdio: 'pipe' });
      return true;
    } catch { return false; }
  }

  isGitClean() {
    try {
      const status = execSync('cd ~/razor-voice-service && git status --porcelain', { encoding: 'utf8' });
      return status.trim() === '';
    } catch { return false; }
  }

  runTests() {
    try {
      const output = execSync('cd ~/razor-voice-service && npm test 2>&1', {
        encoding: 'utf8',
        timeout: 120000
      });
      const passing = output.match(/(\d+) passing/);
      const failing = output.match(/(\d+) failing/);
      return {
        passing: passing ? parseInt(passing[1]) : 0,
        failing: failing ? parseInt(failing[1]) : 0,
        output: output.slice(-500)
      };
    } catch (e) {
      return { passing: 0, failing: 0, error: e.message?.slice(0, 200) };
    }
  }

  assessPhases() {
    const p = CONFIG.projectRoot;

    return {
      phase3: {
        percent: this.calculatePhase3Percent(),
        components: {
          moodDetector: existsSync(join(p, 'src/utils/mood-detector.js')),
          naturalizer: existsSync(join(p, 'src/utils/naturalizer.js')),
          ackPlayer: existsSync(join(p, 'src/audio/ack-player.js')),
          followUpMode: existsSync(join(p, 'src/pipeline/follow-up-mode.js')),
          errorHandler: existsSync(join(p, 'src/utils/error-handler.js'))
        }
      },
      phase4: {
        percent: this.calculatePhase4Percent(),
        components: {
          intelligenceDir: existsSync(join(p, 'src/intelligence')),
          monitor: existsSync(join(p, 'src/intelligence/monitor.js')),
          alertQueue: existsSync(join(p, 'src/intelligence/alert-queue.js')),
          signalScorer: existsSync(join(p, 'src/intelligence/signal-scorer.js')),
          pollers: existsSync(join(p, 'src/intelligence/pollers'))
        }
      },
      phase5: {
        percent: this.calculatePhase5Percent(),
        components: {
          memoryIndex: existsSync(join(p, 'src/memory/index.js')),
          longTermPersistence: existsSync(join(p, 'data/memory.json'))
        }
      },
      phase6: {
        percent: this.calculatePhase6Percent(),
        components: {
          userState: existsSync(join(p, 'src/state/user-state.js')),
          bargeIn: existsSync(join(p, 'src/pipeline/barge-in.js'))
        }
      }
    };
  }

  calculatePhase3Percent() {
    const p = CONFIG.projectRoot;
    let score = 60; // Base from CLAUDE.md
    if (existsSync(join(p, 'src/utils/mood-detector.js'))) score += 10;
    if (existsSync(join(p, 'src/utils/naturalizer.js'))) score += 10;
    if (existsSync(join(p, 'src/audio/ack-player.js'))) score += 10;
    if (existsSync(join(p, 'src/pipeline/follow-up-mode.js'))) score += 10;
    return Math.min(100, score);
  }

  calculatePhase4Percent() {
    const p = CONFIG.projectRoot;
    let score = 0;
    if (existsSync(join(p, 'src/intelligence'))) score += 20;
    if (existsSync(join(p, 'src/intelligence/monitor.js'))) score += 25;
    if (existsSync(join(p, 'src/intelligence/alert-queue.js'))) score += 20;
    if (existsSync(join(p, 'src/intelligence/signal-scorer.js'))) score += 15;
    if (existsSync(join(p, 'src/intelligence/pollers'))) score += 20;
    return score;
  }

  calculatePhase5Percent() {
    const p = CONFIG.projectRoot;
    let score = 40; // Memory exists per CLAUDE.md
    if (existsSync(join(p, 'data/memory.json'))) score += 30;
    if (existsSync(join(p, 'src/memory/long-term-memory.js'))) score += 30;
    return Math.min(100, score);
  }

  calculatePhase6Percent() {
    const p = CONFIG.projectRoot;
    let score = 0;
    if (existsSync(join(p, 'src/state/user-state.js'))) score += 50;
    if (existsSync(join(p, 'src/pipeline/barge-in.js'))) score += 50;
    return score;
  }

  findGaps() {
    const gaps = [];
    const p = CONFIG.projectRoot;

    // Phase 4 gaps (highest priority)
    if (!existsSync(join(p, 'src/intelligence'))) {
      gaps.push({ priority: 1, agent: 4, id: 'intel_dir', task: 'Create src/intelligence directory' });
    }
    if (!existsSync(join(p, 'src/intelligence/monitor.js'))) {
      gaps.push({ priority: 1, agent: 4, id: 'intel_monitor', task: 'Create intelligence monitor' });
    }
    if (!existsSync(join(p, 'src/intelligence/alert-queue.js'))) {
      gaps.push({ priority: 2, agent: 4, id: 'intel_queue', task: 'Create alert queue' });
    }
    if (!existsSync(join(p, 'src/intelligence/signal-scorer.js'))) {
      gaps.push({ priority: 2, agent: 4, id: 'intel_scorer', task: 'Create signal scorer' });
    }

    // Phase 6 gaps
    if (!existsSync(join(p, 'src/state/user-state.js'))) {
      gaps.push({ priority: 2, agent: 6, id: 'user_state', task: 'Create user state manager' });
    }
    if (!existsSync(join(p, 'src/pipeline/barge-in.js'))) {
      gaps.push({ priority: 3, agent: 6, id: 'barge_in', task: 'Create barge-in detection' });
    }

    // Voice improvements
    try {
      const indexJs = readFileSync(join(p, 'src/index.js'), 'utf8');
      if (!indexJs.includes('ensureBluetoothOutput')) {
        gaps.push({ priority: 1, agent: 1, id: 'bt_fix', task: 'Fix Bluetooth audio switching' });
      }
    } catch {}

    // Check feedback for user-reported issues
    const feedback = this.getRecentFeedback();
    if (feedback && feedback.issues) {
      gaps.push({ priority: 0, agent: 0, id: 'user_issue', task: `Fix user-reported: ${feedback.issues}` });
    }

    return gaps.sort((a, b) => a.priority - b.priority);
  }

  getRecentFeedback() {
    try {
      const feedbackDir = PATHS.feedback;
      if (!existsSync(feedbackDir)) return null;

      const files = readdirSync(feedbackDir).filter(f => f.endsWith('.json')).sort().reverse();
      if (files.length === 0) return null;

      return JSON.parse(readFileSync(join(feedbackDir, files[0]), 'utf8'));
    } catch {
      return null;
    }
  }
}

//=== TASK GENERATOR ===//

class TaskGenerator {
  constructor() {
    this.templates = this.loadTemplates();
  }

  loadTemplates() {
    return {
      1: this.voiceTemplate,
      2: this.brainTemplate,
      3: this.integrationTemplate,
      4: this.intelligenceTemplate,
      5: this.memoryTemplate,
      6: this.stateTemplate
    };
  }

  generate(assessment, state) {
    logger.info('Generating tasks...');

    // Clear old tasks
    mkdirSync(PATHS.currentTasks, { recursive: true });
    const oldTasks = readdirSync(PATHS.currentTasks);
    oldTasks.forEach(f => unlinkSync(join(PATHS.currentTasks, f)));

    const gaps = assessment.gaps;
    if (gaps.length === 0) {
      this.writeNoTasksFile(state);
      return { count: 0, files: [] };
    }

    // Group by agent
    const byAgent = {};
    for (const gap of gaps) {
      const agent = gap.agent || this.inferAgent(gap);
      if (!byAgent[agent]) byAgent[agent] = [];
      byAgent[agent].push(gap);
    }

    // Generate task files
    const files = [];
    for (const [agentId, agentGaps] of Object.entries(byAgent)) {
      if (parseInt(agentId) === 0) continue; // Skip unassigned

      const fileName = this.writeAgentTask(parseInt(agentId), agentGaps, assessment, state);
      files.push(fileName);
      state.data.tasksGenerated++;
    }

    state.save();
    return { count: files.length, files };
  }

  inferAgent(gap) {
    const task = gap.task.toLowerCase();
    if (task.includes('audio') || task.includes('voice') || task.includes('bluetooth')) return 1;
    if (task.includes('brain') || task.includes('prompt') || task.includes('llm')) return 2;
    if (task.includes('salesforce') || task.includes('salesloft') || task.includes('integration')) return 3;
    if (task.includes('intelligence') || task.includes('monitor') || task.includes('alert')) return 4;
    if (task.includes('memory') || task.includes('context')) return 5;
    if (task.includes('state') || task.includes('barge')) return 6;
    return 2; // Default to brain
  }

  writeAgentTask(agentId, gaps, assessment, state) {
    const agent = CONFIG.agents[agentId];
    const fileName = `agent${agentId}_${agent.name.toLowerCase()}.md`;
    const filePath = join(PATHS.currentTasks, fileName);

    const template = this.templates[agentId];
    const content = template.call(this, agentId, agent, gaps, assessment, state);

    writeFileSync(filePath, content);
    logger.info(`Task generated: ${fileName}`);

    return fileName;
  }

  voiceTemplate(agentId, agent, gaps, assessment, state) {
    return `# Agent ${agentId}: ${agent.name}

## RCDL Cycle ${state.data.totalCycles}

Read CLAUDE.md first.

## YOUR DOMAIN
${agent.domain}

## TASKS (Priority Order)

${gaps.map((g, i) => `### ${i + 1}. ${g.task}`).join('\n\n')}

## SPECIFIC INSTRUCTIONS

### Fix Bluetooth Audio Switching

Ensure all audio plays on X8 Pro headset, never Mac speakers.

FILE: src/audio/bluetooth.js
- Add ensureBluetoothOutput() function
- Check current output before every playback
- Switch to X8 Pro if not active

FILE: src/audio/playback.js
- Import and call ensureBluetoothOutput() at start of playAudio()

FILE: src/audio/ack-player.js
- Import and call ensureBluetoothOutput() before playing ack

## COMPLETION

When done, say: "AGENT ${agentId} COMPLETE"

Then run: node ~/razor-voice-service/rcdl/complete.js ${agentId}
`;
  }

  intelligenceTemplate(agentId, agent, gaps, assessment, state) {
    return `# Agent ${agentId}: ${agent.name}

## RCDL Cycle ${state.data.totalCycles}

Read CLAUDE.md first.

## YOUR DOMAIN
${agent.domain}

## MISSION
Build proactive monitoring that alerts AL to engagement signals.

## TASKS (Priority Order)

${gaps.map((g, i) => `### ${i + 1}. ${g.task}`).join('\n\n')}

## KEY DATA
- Salesloft user_id: 89440
- Email: alrazi@telnyx.com

## FILES TO CREATE

### src/intelligence/monitor.js
- Poll Salesloft every 60 seconds
- Track opens, clicks, replies
- Detect CHANGES from previous state
- Queue alerts for delivery

### src/intelligence/alert-queue.js
- Priority queue for alerts
- Deduplication (same alert once per hour)
- Format alerts naturally: "Heads up — Sarah clicked your link"

### src/intelligence/signal-scorer.js
- Reply = 100 points (urgent)
- Click = 75 points (hot)
- 3+ Opens = 50 points (warm)

### src/intelligence/index.js
- Export all components

## COMPLETION

When done, say: "AGENT ${agentId} COMPLETE"

Then run: node ~/razor-voice-service/rcdl/complete.js ${agentId}
`;
  }

  stateTemplate(agentId, agent, gaps, assessment, state) {
    return `# Agent ${agentId}: ${agent.name}

## RCDL Cycle ${state.data.totalCycles}

Read CLAUDE.md first.

## YOUR DOMAIN
${agent.domain}

## TASKS (Priority Order)

${gaps.map((g, i) => `### ${i + 1}. ${g.task}`).join('\n\n')}

## FILES TO CREATE

### src/state/user-state.js
- States: AVAILABLE, IN_CALL, FOCUSED, DND
- Parse voice commands to change state
- Queue alerts when not available

### src/pipeline/barge-in.js
- Detect user speech during playback
- Stop playback immediately
- Return to listening state

## COMPLETION

When done, say: "AGENT ${agentId} COMPLETE"

Then run: node ~/razor-voice-service/rcdl/complete.js ${agentId}
`;
  }

  brainTemplate(agentId, agent, gaps, assessment, state) {
    return `# Agent ${agentId}: ${agent.name}

## RCDL Cycle ${state.data.totalCycles}

Read CLAUDE.md first.

## YOUR DOMAIN
${agent.domain}

## TASKS

${gaps.map((g, i) => `### ${i + 1}. ${g.task}`).join('\n\n')}

## COMPLETION

When done, say: "AGENT ${agentId} COMPLETE"

Then run: node ~/razor-voice-service/rcdl/complete.js ${agentId}
`;
  }

  integrationTemplate(agentId, agent, gaps, assessment, state) {
    return this.brainTemplate(agentId, agent, gaps, assessment, state);
  }

  memoryTemplate(agentId, agent, gaps, assessment, state) {
    return `# Agent ${agentId}: ${agent.name}

## RCDL Cycle ${state.data.totalCycles}

Read CLAUDE.md first.

Memory is Phase 3 Complete per CLAUDE.md. Audit and enhance only.

## TASKS

${gaps.map((g, i) => `### ${i + 1}. ${g.task}`).join('\n\n')}

## AUDIT COMMANDS

\`\`\`bash
grep -r "memory\\." ~/razor-voice-service/src/index.js | head -10
ls -la ~/razor-voice-service/data/
\`\`\`

## COMPLETION

When done, say: "AGENT ${agentId} COMPLETE"

Then run: node ~/razor-voice-service/rcdl/complete.js ${agentId}
`;
  }

  writeNoTasksFile(state) {
    const content = `# No Tasks Needed

## RCDL Cycle ${state.data.totalCycles}

All identified gaps have been addressed!

## CURRENT STATE

- Phase 3: ${state.data.phases.phase3.percent}%
- Phase 4: ${state.data.phases.phase4.percent}%
- Phase 5: ${state.data.phases.phase5.percent}%
- Phase 6: ${state.data.phases.phase6.percent}%

## WHAT'S NEXT

1. **Test Razor** — Run voice commands
2. **Provide Feedback** — node rcdl/feedback.js
3. **Continue Cycle** — node rcdl/engine.js

The lifecycle continues automatically.
`;

    writeFileSync(join(PATHS.currentTasks, 'NO_TASKS.md'), content);
  }
}

//=== HUMAN CHECKPOINT ===//

class HumanCheckpoint {
  check(state, assessment) {
    if (!state.needsHumanCheck()) {
      return { needed: false };
    }

    logger.info('Human checkpoint reached');
    state.setStatus('waiting_for_human', 'Daily testing checkpoint');

    this.writeCheckpointFile(state, assessment);

    return {
      needed: true,
      reason: 'Daily testing checkpoint',
      cyclesSinceLastCheck: state.data.cyclesSinceHumanCheck
    };
  }

  writeCheckpointFile(state, assessment) {
    const content = `
╔═══════════════════════════════════════════════════════════════════════════╗
║                         HUMAN TESTING CHECKPOINT                          ║
╠═══════════════════════════════════════════════════════════════════════════╣
║                                                                           ║
║  Cycle: ${String(state.data.totalCycles).padEnd(10)}                                                  ║
║  Tasks Completed: ${String(state.data.tasksCompleted).padEnd(10)}                                      ║
║  Since Last Check: ${String(state.data.cyclesSinceHumanCheck).padEnd(5)} cycles                              ║
║                                                                           ║
╠═══════════════════════════════════════════════════════════════════════════╣
║  PHASE STATUS                                                             ║
║  ───────────                                                              ║
║  Phase 3 (Humanization):   ${String(assessment.phases.phase3.percent).padEnd(3)}%                              ║
║  Phase 4 (Intelligence):   ${String(assessment.phases.phase4.percent).padEnd(3)}%                              ║
║  Phase 5 (Learning):       ${String(assessment.phases.phase5.percent).padEnd(3)}%                              ║
║  Phase 6 (Autonomy):       ${String(assessment.phases.phase6.percent).padEnd(3)}%                              ║
║                                                                           ║
╠═══════════════════════════════════════════════════════════════════════════╣
║  PLEASE TEST                                                              ║
║  ───────────                                                              ║
║                                                                           ║
║  1. Start Razor (if not running):                                        ║
║     cd ~/razor-voice-service && npm start                                ║
║                                                                           ║
║  2. Test these commands:                                                  ║
║     • "Razor, how much pipeline"                                         ║
║     • "Razor, any hot leads"                                             ║
║     • "Tell me more" (follow-up test)                                    ║
║     • "Razor, I'm on a call" (state test)                               ║
║                                                                           ║
║  3. Note what works and what doesn't                                     ║
║                                                                           ║
║  4. Provide feedback:                                                     ║
║     node ~/razor-voice-service/rcdl/feedback.js                          ║
║                                                                           ║
║  5. Continue development:                                                 ║
║     node ~/razor-voice-service/rcdl/engine.js                            ║
║                                                                           ║
╚═══════════════════════════════════════════════════════════════════════════╝
`;

    writeFileSync(join(PATHS.currentTasks, 'HUMAN_CHECKPOINT.txt'), content);
    console.log(content);
  }
}

//=== DISPLAY ===//

class Display {
  showBanner() {
    console.log(`
╔═══════════════════════════════════════════════════════════════════════════╗
║                                                                           ║
║   ██████╗  ██████╗██████╗ ██╗                                            ║
║   ██╔══██╗██╔════╝██╔══██╗██║                                            ║
║   ██████╔╝██║     ██║  ██║██║                                            ║
║   ██╔══██╗██║     ██║  ██║██║                                            ║
║   ██║  ██║╚██████╗██████╔╝███████╗                                       ║
║   ╚═╝  ╚═╝ ╚═════╝╚═════╝ ╚══════╝                                       ║
║                                                                           ║
║   RAZOR CONTINUOUS DEVELOPMENT LIFECYCLE                                 ║
║   ∞ Building Forever ∞                                                   ║
║                                                                           ║
╚═══════════════════════════════════════════════════════════════════════════╝
    `);
  }

  showStatus(state, assessment, tasks) {
    const s = state.data;
    const a = assessment;

    console.log(`
┌─────────────────────────────────────────────────────────────────────────┐
│ CYCLE ${String(s.totalCycles).padEnd(6)} │ STATUS: ${s.status.toUpperCase().padEnd(20)}                │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│ HEALTH                                                                  │
│ ──────                                                                  │
│   Brain:  ${a.health.brain ? '✅ Running' : '❌ Stopped'}                                              │
│   Voice:  ${a.health.voice ? '✅ Running' : '❌ Stopped'}                                              │
│   Tests:  ${String(a.tests.passing).padEnd(3)} passing, ${String(a.tests.failing).padEnd(3)} failing                          │
│                                                                         │
│ PHASES                                                                  │
│ ──────                                                                  │
│   Phase 3 Humanization:   ${'█'.repeat(Math.floor(a.phases.phase3.percent / 10))}${'░'.repeat(10 - Math.floor(a.phases.phase3.percent / 10))} ${String(a.phases.phase3.percent).padStart(3)}%     │
│   Phase 4 Intelligence:   ${'█'.repeat(Math.floor(a.phases.phase4.percent / 10))}${'░'.repeat(10 - Math.floor(a.phases.phase4.percent / 10))} ${String(a.phases.phase4.percent).padStart(3)}%     │
│   Phase 5 Learning:       ${'█'.repeat(Math.floor(a.phases.phase5.percent / 10))}${'░'.repeat(10 - Math.floor(a.phases.phase5.percent / 10))} ${String(a.phases.phase5.percent).padStart(3)}%     │
│   Phase 6 Autonomy:       ${'█'.repeat(Math.floor(a.phases.phase6.percent / 10))}${'░'.repeat(10 - Math.floor(a.phases.phase6.percent / 10))} ${String(a.phases.phase6.percent).padStart(3)}%     │
│                                                                         │
│ STATS                                                                   │
│ ─────                                                                   │
│   Total Cycles:     ${String(s.totalCycles).padEnd(10)}                                     │
│   Tasks Completed:  ${String(s.tasksCompleted).padEnd(10)}                                     │
│   Since Last Test:  ${String(s.cyclesSinceHumanCheck).padEnd(5)} cycles                                │
│                                                                         │
│ TASKS THIS CYCLE: ${String(tasks.count).padEnd(3)}                                             │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
    `);

    if (tasks.count > 0) {
      console.log(`
┌─────────────────────────────────────────────────────────────────────────┐
│ NEXT STEPS                                                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│ 1. View tasks:                                                          │
│    ls ~/razor-voice-service/rcdl/agents/current/                       │
│                                                                         │
│ 2. For each agent task:                                                 │
│    cat ~/razor-voice-service/rcdl/agents/current/agent4_intelligence.md│
│    → Copy and paste into Claude Code tab                               │
│                                                                         │
│ 3. When agent completes:                                                │
│    node ~/razor-voice-service/rcdl/complete.js 4                       │
│                                                                         │
│ 4. Continue lifecycle:                                                  │
│    node ~/razor-voice-service/rcdl/engine.js                           │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
      `);
    }
  }
}

//=== MAIN ENGINE ===//

class RCDLEngine {
  constructor() {
    this.state = new RCDLState();
    this.assessor = new ProjectAssessor();
    this.generator = new TaskGenerator();
    this.checkpoint = new HumanCheckpoint();
    this.display = new Display();
  }

  run() {
    this.display.showBanner();

    // Check if waiting for human
    if (this.state.data.status === 'waiting_for_human') {
      console.log('\n⏸  PAUSED - Waiting for human feedback');
      console.log('   Run: node ~/razor-voice-service/rcdl/feedback.js\n');
      return;
    }

    // Increment cycle
    this.state.incrementCycle();
    logger.info(`Starting cycle ${this.state.data.totalCycles}`);

    // Assess
    const assessment = this.assessor.assess();

    // Update phase percentages
    this.state.updatePhase('phase3', assessment.phases.phase3.percent);
    this.state.updatePhase('phase4', assessment.phases.phase4.percent);
    this.state.updatePhase('phase5', assessment.phases.phase5.percent);
    this.state.updatePhase('phase6', assessment.phases.phase6.percent);

    // Check for human checkpoint
    const humanCheck = this.checkpoint.check(this.state, assessment);
    if (humanCheck.needed) {
      return;
    }

    // Generate tasks
    const tasks = this.generator.generate(assessment, this.state);

    // Display status
    this.display.showStatus(this.state, assessment, tasks);

    // Commit changes periodically
    if (this.state.data.totalCycles % 5 === 0) {
      this.commitChanges();
    }

    logger.info(`Cycle ${this.state.data.totalCycles} complete`);
  }

  commitChanges() {
    try {
      execSync(
        `cd ~/razor-voice-service && git add -A && git commit -m "RCDL cycle ${this.state.data.totalCycles}" --allow-empty`,
        { stdio: 'pipe' }
      );
      logger.info('Changes committed to git');
    } catch {}
  }
}

//=== RUN ===//

const engine = new RCDLEngine();
engine.run();
