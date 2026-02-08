#!/bin/bash

echo "╔═══════════════════════════════════════════════════════════════╗"
echo "║                    PENDING TASKS                              ║"
echo "╚═══════════════════════════════════════════════════════════════╝"
echo ""

TASKS_DIR=~/razor-voice-service/orchestrator/tasks

if [ -z "$(ls -A $TASKS_DIR 2>/dev/null)" ]; then
  echo "No pending tasks. Run: node orchestrator/index.js"
else
  for f in $TASKS_DIR/*.md; do
    if [ -f "$f" ]; then
      echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
      echo "FILE: $(basename $f)"
      echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
      head -30 "$f"
      echo ""
      echo "[...truncated. Run: cat $f for full content]"
      echo ""
    fi
  done
fi
