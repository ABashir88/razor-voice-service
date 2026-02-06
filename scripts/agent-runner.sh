#!/bin/bash
# Agent Runner - Watches for tasks and executes them

AGENT_NAME=$1
TASKS_DIR=~/razor-voice-service/tasks

if [ -z "$AGENT_NAME" ]; then
  echo "Usage: ./agent-runner.sh <agent-name>"
  exit 1
fi

echo "🤖 Agent $AGENT_NAME watching for tasks..."

while true; do
  # Find next pending task for this agent
  TASK_FILE=$(ls -1 $TASKS_DIR/pending/${AGENT_NAME}_*.md 2>/dev/null | head -1)
  
  if [ -n "$TASK_FILE" ]; then
    TASK_NAME=$(basename "$TASK_FILE")
    echo "📋 Found task: $TASK_NAME"
    
    # Move to active
    mv "$TASK_FILE" "$TASKS_DIR/active/"
    
    # Read spec and execute with Claude Code
    SPEC=$(cat "$TASKS_DIR/active/$TASK_NAME")
    
    cd ~/razor-voice-service
    echo "$SPEC" | claude --print > "$TASKS_DIR/complete/${TASK_NAME%.md}_result.md" 2>&1
    
    # Move to complete
    mv "$TASKS_DIR/active/$TASK_NAME" "$TASKS_DIR/complete/"
    
    echo "✅ Task complete: $TASK_NAME"
  fi
  
  sleep 5
done
