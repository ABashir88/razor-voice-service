#!/bin/bash
# install-daemon.sh — Install Razor launchd services
# Copies plists to ~/Library/LaunchAgents/ and loads them

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LAUNCH_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$PROJECT_DIR/logs"

VOICE_PLIST="com.razor.voice.plist"
BRAIN_PLIST="com.razor.brain.plist"

echo "=== Razor Daemon Installer ==="
echo "Project: $PROJECT_DIR"
echo ""

# Create logs directory
if [ ! -d "$LOG_DIR" ]; then
    mkdir -p "$LOG_DIR"
    echo "[+] Created $LOG_DIR"
else
    echo "[=] $LOG_DIR already exists"
fi

# Create LaunchAgents directory if needed
if [ ! -d "$LAUNCH_DIR" ]; then
    mkdir -p "$LAUNCH_DIR"
    echo "[+] Created $LAUNCH_DIR"
fi

# Unload existing services (ignore errors if not loaded)
echo ""
echo "--- Unloading existing services ---"
launchctl bootout "gui/$(id -u)/$VOICE_PLIST" 2>/dev/null && echo "[~] Unloaded $VOICE_PLIST" || echo "[=] $VOICE_PLIST was not loaded"
launchctl bootout "gui/$(id -u)/$BRAIN_PLIST" 2>/dev/null && echo "[~] Unloaded $BRAIN_PLIST" || echo "[=] $BRAIN_PLIST was not loaded"

# Copy plists
echo ""
echo "--- Installing plists ---"
cp "$PROJECT_DIR/$VOICE_PLIST" "$LAUNCH_DIR/$VOICE_PLIST"
echo "[+] Copied $VOICE_PLIST → $LAUNCH_DIR/"

cp "$PROJECT_DIR/$BRAIN_PLIST" "$LAUNCH_DIR/$BRAIN_PLIST"
echo "[+] Copied $BRAIN_PLIST → $LAUNCH_DIR/"

# Load services
echo ""
echo "--- Loading services ---"
launchctl bootstrap "gui/$(id -u)" "$LAUNCH_DIR/$VOICE_PLIST"
echo "[+] Loaded $VOICE_PLIST"

launchctl bootstrap "gui/$(id -u)" "$LAUNCH_DIR/$BRAIN_PLIST"
echo "[+] Loaded $BRAIN_PLIST"

# Verify
echo ""
echo "--- Verifying ---"
sleep 2

if launchctl print "gui/$(id -u)/com.razor.voice" &>/dev/null; then
    echo "[OK] com.razor.voice is running"
else
    echo "[!!] com.razor.voice failed to start — check $LOG_DIR/voice-error.log"
fi

if launchctl print "gui/$(id -u)/com.razor.brain" &>/dev/null; then
    echo "[OK] com.razor.brain is running"
else
    echo "[!!] com.razor.brain failed to start — check $LOG_DIR/brain-error.log"
fi

echo ""
echo "=== Done ==="
echo "Logs:     $LOG_DIR/"
echo "Uninstall: scripts/uninstall-daemon.sh"
