#!/bin/bash

echo "╔═══════════════════════════════════════════════════════════════╗"
echo "║                    RAZOR BUILD SYSTEM                         ║"
echo "╚═══════════════════════════════════════════════════════════════╝"
echo ""

cd ~/razor-voice-service

# Create directories
mkdir -p orchestrator/{tasks,state,logs}

# Run orchestrator
node orchestrator/index.js

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "WORKFLOW:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "1. View tasks:     ./orchestrator/view-tasks.sh"
echo "2. Copy a task:    cat orchestrator/tasks/agent4_intelligence.md"
echo "3. Paste into Claude Code tab"
echo "4. When done:      node orchestrator/complete.js 4"
echo "5. Get next tasks: node orchestrator/index.js"
echo ""
