#!/bin/bash

echo ""
echo "╔═══════════════════════════════════════════════════════════════════════════╗"
echo "║                                                                           ║"
echo "║   RAZOR CONTINUOUS DEVELOPMENT LIFECYCLE                                 ║"
echo "║   ∞ STARTING ∞                                                           ║"
echo "║                                                                           ║"
echo "╚═══════════════════════════════════════════════════════════════════════════╝"
echo ""

cd ~/razor-voice-service

# Create directories
mkdir -p rcdl/{cycles,feedback,milestones,agents/current,logs}

# Run engine
node rcdl/engine.js
