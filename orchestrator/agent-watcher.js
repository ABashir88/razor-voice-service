/**
 * AGENT TASK WATCHER
 *
 * Runs in Claude Code tabs.
 * Watches for new tasks from orchestrator.
 * Executes and reports completion.
 */

import { watch, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const AGENT_ID = process.argv[2] || '1';
const TASKS_DIR = join(process.env.HOME, 'razor-voice-service/orchestrator/tasks');
const TASK_FILE = join(TASKS_DIR, `agent${AGENT_ID}_current.md`);

console.log(`[Agent ${AGENT_ID}] Watcher started. Monitoring: ${TASK_FILE}`);

// Watch for task file changes
const checkForTask = () => {
  if (existsSync(TASK_FILE)) {
    const task = readFileSync(TASK_FILE, 'utf8');
    console.log(`[Agent ${AGENT_ID}] New task detected!`);
    console.log('─'.repeat(50));
    console.log(task);
    console.log('─'.repeat(50));
    console.log(`\n[Agent ${AGENT_ID}] Copy the instructions above into Claude Code.\n`);
  }
};

// Check immediately
checkForTask();

// Then watch for changes
setInterval(checkForTask, 10000); // Check every 10 seconds
