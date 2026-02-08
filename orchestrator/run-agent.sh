#!/bin/bash

AGENT_ID=$1

if [ -z "$AGENT_ID" ]; then
  echo "Usage: ./run-agent.sh <agent_number>"
  echo "Example: ./run-agent.sh 1"
  exit 1
fi

echo "╔════════════════════════════════════════════════════════════╗"
echo "║           AGENT $AGENT_ID WATCHER                               ║"
echo "╚════════════════════════════════════════════════════════════╝"

cd ~/razor-voice-service

# Watch for tasks
while true; do
  TASK_FILE="orchestrator/tasks/agent${AGENT_ID}_current.md"

  if [ -f "$TASK_FILE" ]; then
    echo ""
    echo "═══════════════════════════════════════════════════════════"
    echo "NEW TASK FOR AGENT $AGENT_ID"
    echo "═══════════════════════════════════════════════════════════"
    cat "$TASK_FILE"
    echo "═══════════════════════════════════════════════════════════"
    echo ""
    echo "Paste the above into Claude Code, then delete the task file:"
    echo "rm $TASK_FILE"
    echo ""
  fi

  sleep 10
done
