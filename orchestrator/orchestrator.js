/**
 * RAZOR ORCHESTRATOR
 *
 * The master agent that never sleeps.
 * Continuously assesses, plans, dispatches, and verifies.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { execSync, spawn } from 'child_process';
import { join } from 'path';

const PROJECT_ROOT = join(process.env.HOME, 'razor-voice-service');
const ORCH_ROOT = join(PROJECT_ROOT, 'orchestrator');
const TASKS_DIR = join(ORCH_ROOT, 'tasks');
const LOGS_DIR = join(ORCH_ROOT, 'logs');

class RazorOrchestrator {
  constructor() {
    this.state = {
      cycle: 0,
      lastAssessment: null,
      activeAgents: new Map(),
      taskQueue: [],
      completedTasks: [],
      blockers: []
    };

    this.agents = {
      1: { name: 'Voice', domain: 'audio', status: 'idle' },
      2: { name: 'Brain', domain: 'llm', status: 'idle' },
      3: { name: 'Integration', domain: 'data', status: 'idle' },
      4: { name: 'Intelligence', domain: 'proactive', status: 'idle' },
      5: { name: 'Memory', domain: 'context', status: 'idle' },
      6: { name: 'State', domain: 'control', status: 'idle' }
    };

    this.priorities = {
      P0: [], // Blocking
      P1: [], // User experience
      P2: [], // Missing features
      P3: [], // Enhancements
      P4: []  // Future
    };
  }

  //=== MAIN LOOP ===//

  async run() {
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║           RAZOR ORCHESTRATOR - STARTING                    ║');
    console.log('╚════════════════════════════════════════════════════════════╝');

    while (true) {
      this.state.cycle++;
      console.log(`\n[Cycle ${this.state.cycle}] ─────────────────────────────────`);

      try {
        // Step 1: Assess current state
        const assessment = await this.assess();

        // Step 2: Plan next actions
        const plan = await this.plan(assessment);

        // Step 3: Dispatch to agents
        await this.dispatch(plan);

        // Step 4: Verify progress
        await this.verify();

        // Step 5: Report
        this.report();

      } catch (error) {
        console.error(`[Orchestrator] Error in cycle: ${error.message}`);
        this.state.blockers.push({ cycle: this.state.cycle, error: error.message });
      }

      // Wait before next cycle (configurable)
      await this.sleep(30000); // 30 seconds between cycles
    }
  }

  //=== ASSESS ===//

  async assess() {
    console.log('[Assess] Checking project state...');

    const assessment = {
      timestamp: new Date().toISOString(),
      health: {},
      phases: {},
      issues: [],
      opportunities: []
    };

    // Check if services are running
    assessment.health.brain = this.isProcessRunning('razor_brain.server');
    assessment.health.voice = this.isProcessRunning('node.*index.js');
    assessment.health.tests = this.runTests();

    // Read CLAUDE.md for phase status
    const claudeMd = this.readFile(join(PROJECT_ROOT, 'CLAUDE.md'));
    assessment.phases = this.parsePhaseStatus(claudeMd);

    // Check for recent errors
    assessment.issues = this.checkLogs();

    // Identify opportunities
    assessment.opportunities = this.identifyOpportunities(assessment);

    this.state.lastAssessment = assessment;
    console.log(`[Assess] Health: Brain=${assessment.health.brain ? '✓' : '✗'}, Voice=${assessment.health.voice ? '✓' : '✗'}`);

    return assessment;
  }

  isProcessRunning(pattern) {
    try {
      execSync(`pgrep -f "${pattern}"`, { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  runTests() {
    try {
      const result = execSync('cd ~/razor-voice-service && npm test 2>&1', {
        encoding: 'utf8',
        timeout: 60000
      });
      const match = result.match(/(\d+) passing/);
      return { passing: match ? parseInt(match[1]) : 0, output: result.slice(-500) };
    } catch (error) {
      return { passing: 0, error: error.message };
    }
  }

  parsePhaseStatus(claudeMd) {
    const phases = {};
    // Parse phase completion from CLAUDE.md
    const phasePattern = /Phase (\d+)[^│]*│[^│]*│\s*(\d+)%/g;
    let match;
    while ((match = phasePattern.exec(claudeMd)) !== null) {
      phases[`phase${match[1]}`] = parseInt(match[2]);
    }
    return phases;
  }

  checkLogs() {
    const issues = [];
    try {
      const brainLog = this.readFile('/tmp/brain-test.log');
      const voiceLog = this.readFile('/tmp/razor-test.log');

      // Check for errors
      if (brainLog.includes('Error') || brainLog.includes('error')) {
        issues.push({ source: 'brain', type: 'error', snippet: this.extractError(brainLog) });
      }
      if (voiceLog.includes('Error') || voiceLog.includes('error')) {
        issues.push({ source: 'voice', type: 'error', snippet: this.extractError(voiceLog) });
      }
    } catch {}
    return issues;
  }

  extractError(log) {
    const lines = log.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes('error')) {
        return lines.slice(i, i + 3).join('\n');
      }
    }
    return '';
  }

  identifyOpportunities(assessment) {
    const opportunities = [];

    // Services not running
    if (!assessment.health.brain) {
      opportunities.push({ priority: 'P0', task: 'start_brain', description: 'Brain server not running' });
    }
    if (!assessment.health.voice) {
      opportunities.push({ priority: 'P0', task: 'start_voice', description: 'Voice service not running' });
    }

    // Phase completion
    if (assessment.phases.phase3 < 100) {
      opportunities.push({ priority: 'P1', task: 'complete_phase3', description: 'Phase 3 (Humanization) incomplete' });
    }
    if (assessment.phases.phase4 < 50) {
      opportunities.push({ priority: 'P2', task: 'build_intelligence', description: 'Phase 4 (Intelligence) needs work' });
    }

    // Check for specific missing components
    if (!existsSync(join(PROJECT_ROOT, 'src/intelligence/monitor.js'))) {
      opportunities.push({ priority: 'P2', task: 'create_intelligence_monitor', description: 'Intelligence monitor missing' });
    }

    return opportunities;
  }

  //=== PLAN ===//

  async plan(assessment) {
    console.log('[Plan] Creating action plan...');

    const plan = {
      immediate: [],
      shortTerm: [],
      scheduled: []
    };

    // Prioritize opportunities
    for (const opp of assessment.opportunities) {
      const task = this.createTask(opp);

      if (opp.priority === 'P0') {
        plan.immediate.push(task);
      } else if (opp.priority === 'P1') {
        plan.shortTerm.push(task);
      } else {
        plan.scheduled.push(task);
      }
    }

    // Also check for stalled tasks
    for (const [agentId, agent] of Object.entries(this.agents)) {
      if (agent.status === 'working' && agent.startTime) {
        const elapsed = Date.now() - agent.startTime;
        if (elapsed > 300000) { // 5 minutes
          plan.immediate.push({
            type: 'check_agent',
            agentId,
            reason: 'Agent appears stalled'
          });
        }
      }
    }

    console.log(`[Plan] Immediate: ${plan.immediate.length}, Short-term: ${plan.shortTerm.length}`);
    return plan;
  }

  createTask(opportunity) {
    const taskTemplates = {
      start_brain: {
        agent: null, // Orchestrator handles
        command: 'cd ~/razor-voice-service/brain && python3 -m razor_brain.server &',
        verify: () => this.isProcessRunning('razor_brain.server')
      },
      start_voice: {
        agent: null,
        command: 'cd ~/razor-voice-service && npm start &',
        verify: () => this.isProcessRunning('node.*index.js')
      },
      complete_phase3: {
        agent: 1, // Voice agent
        prompt: this.getAgentPrompt(1, 'complete_humanization'),
        verify: () => this.checkPhaseComplete(3)
      },
      build_intelligence: {
        agent: 4,
        prompt: this.getAgentPrompt(4, 'build_intelligence'),
        verify: () => existsSync(join(PROJECT_ROOT, 'src/intelligence/monitor.js'))
      },
      create_intelligence_monitor: {
        agent: 4,
        prompt: this.getAgentPrompt(4, 'create_monitor'),
        verify: () => existsSync(join(PROJECT_ROOT, 'src/intelligence/monitor.js'))
      }
    };

    return {
      id: `task_${Date.now()}_${opportunity.task}`,
      ...opportunity,
      ...taskTemplates[opportunity.task]
    };
  }

  //=== DISPATCH ===//

  async dispatch(plan) {
    console.log('[Dispatch] Assigning tasks to agents...');

    // Handle immediate tasks (orchestrator does these)
    for (const task of plan.immediate) {
      if (task.command && !task.agent) {
        console.log(`[Dispatch] Executing: ${task.command}`);
        try {
          execSync(task.command, { stdio: 'inherit' });
        } catch (e) {
          console.error(`[Dispatch] Command failed: ${e.message}`);
        }
      }
    }

    // Dispatch to agents
    const allTasks = [...plan.immediate, ...plan.shortTerm].filter(t => t.agent);

    for (const task of allTasks) {
      const agent = this.agents[task.agent];

      if (agent.status === 'idle') {
        console.log(`[Dispatch] Assigning to Agent ${task.agent} (${agent.name}): ${task.description}`);

        // Write task file for agent
        this.writeTaskFile(task);

        // Update agent status
        agent.status = 'working';
        agent.currentTask = task.id;
        agent.startTime = Date.now();

        this.state.activeAgents.set(task.agent, task);
      }
    }
  }

  writeTaskFile(task) {
    const taskFile = join(TASKS_DIR, `agent${task.agent}_current.md`);
    const content = `# Task for Agent ${task.agent}

## Task ID: ${task.id}
## Priority: ${task.priority}
## Description: ${task.description}

## Instructions

${task.prompt || 'No specific prompt - use agent discretion.'}

## Verification

Task is complete when the orchestrator can verify:
- ${task.verify ? 'Automated check will run' : 'Manual verification needed'}

## Started: ${new Date().toISOString()}
`;

    writeFileSync(taskFile, content);
    console.log(`[Dispatch] Task file written: ${taskFile}`);
  }

  //=== VERIFY ===//

  async verify() {
    console.log('[Verify] Checking task completion...');

    for (const [agentId, task] of this.state.activeAgents) {
      if (task.verify) {
        try {
          const isComplete = task.verify();

          if (isComplete) {
            console.log(`[Verify] ✓ Agent ${agentId} completed: ${task.description}`);
            this.agents[agentId].status = 'idle';
            this.agents[agentId].currentTask = null;
            this.state.completedTasks.push({
              ...task,
              completedAt: new Date().toISOString()
            });
            this.state.activeAgents.delete(agentId);

            // Clean up task file
            const taskFile = join(TASKS_DIR, `agent${agentId}_current.md`);
            if (existsSync(taskFile)) {
              const archiveFile = join(TASKS_DIR, `completed_${task.id}.md`);
              execSync(`mv ${taskFile} ${archiveFile}`);
            }
          }
        } catch (e) {
          console.error(`[Verify] Error checking Agent ${agentId}: ${e.message}`);
        }
      }
    }
  }

  //=== REPORT ===//

  report() {
    console.log('\n[Report] ═══════════════════════════════════════════════');
    console.log(`Cycle: ${this.state.cycle}`);
    console.log(`Active Agents: ${this.state.activeAgents.size}`);
    console.log(`Completed Tasks: ${this.state.completedTasks.length}`);
    console.log(`Blockers: ${this.state.blockers.length}`);

    for (const [agentId, agent] of Object.entries(this.agents)) {
      const status = agent.status === 'working' ? '🔨' : '💤';
      console.log(`  Agent ${agentId} (${agent.name}): ${status} ${agent.currentTask || 'idle'}`);
    }

    console.log('════════════════════════════════════════════════════════\n');

    // Write status to file
    this.writeStatus();
  }

  writeStatus() {
    const status = {
      lastUpdate: new Date().toISOString(),
      cycle: this.state.cycle,
      agents: this.agents,
      activeTaskCount: this.state.activeAgents.size,
      completedTaskCount: this.state.completedTasks.length,
      lastAssessment: this.state.lastAssessment
    };

    writeFileSync(
      join(ORCH_ROOT, 'status.json'),
      JSON.stringify(status, null, 2)
    );
  }

  //=== AGENT PROMPTS ===//

  getAgentPrompt(agentId, taskType) {
    const prompts = {
      1: { // Voice Agent
        complete_humanization: `Read CLAUDE.md.

You are Agent 1: Voice Agent.

TASK: Complete Phase 3 Humanization

1. Check TTS audio quality settings
2. Shorten all response text (max 80 chars for TTS)
3. Speed up playback (rate 1.15)
4. Fix Bluetooth switching issues
5. Verify ack player works

Test and report completion.`,
      },
      4: { // Intelligence Agent
        build_intelligence: `Read CLAUDE.md.

You are Agent 4: Intelligence Agent.

TASK: Build the complete intelligence layer.

Create these files:
- src/intelligence/monitor.js
- src/intelligence/pollers/salesloft-poller.js
- src/intelligence/signal-scorer.js
- src/intelligence/alert-queue.js
- src/intelligence/index.js

User ID: 89440 (Salesloft)

Report when complete.`,
        create_monitor: `Read CLAUDE.md.

You are Agent 4: Intelligence Agent.

TASK: Create src/intelligence/monitor.js

This should poll Salesloft every 60 seconds and detect changes in opens/clicks/replies.

Report when complete.`
      }
    };

    return prompts[agentId]?.[taskType] || `Read CLAUDE.md. Execute task: ${taskType}`;
  }

  //=== UTILITIES ===//

  readFile(path) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return '';
    }
  }

  checkPhaseComplete(phase) {
    const claudeMd = this.readFile(join(PROJECT_ROOT, 'CLAUDE.md'));
    const match = claudeMd.match(new RegExp(`Phase ${phase}[^│]*│[^│]*│\\s*(\\d+)%`));
    return match && parseInt(match[1]) >= 100;
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Run orchestrator
const orchestrator = new RazorOrchestrator();
orchestrator.run().catch(console.error);
