#!/bin/bash
# uninstall-daemon.sh — Remove Razor launchd services
# Unloads services and removes plists from ~/Library/LaunchAgents/

set -euo pipefail

LAUNCH_DIR="$HOME/Library/LaunchAgents"
UID_NUM="$(id -u)"

VOICE_PLIST="com.razor.voice.plist"
BRAIN_PLIST="com.razor.brain.plist"

echo "=== Razor Daemon Uninstaller ==="
echo ""

# Unload services
echo "--- Unloading services ---"
launchctl bootout "gui/$UID_NUM/com.razor.voice" 2>/dev/null && echo "[+] Unloaded com.razor.voice" || echo "[=] com.razor.voice was not loaded"
launchctl bootout "gui/$UID_NUM/com.razor.brain" 2>/dev/null && echo "[+] Unloaded com.razor.brain" || echo "[=] com.razor.brain was not loaded"

# Remove plists
echo ""
echo "--- Removing plists ---"
if [ -f "$LAUNCH_DIR/$VOICE_PLIST" ]; then
    rm "$LAUNCH_DIR/$VOICE_PLIST"
    echo "[+] Removed $LAUNCH_DIR/$VOICE_PLIST"
else
    echo "[=] $VOICE_PLIST not found in $LAUNCH_DIR"
fi

if [ -f "$LAUNCH_DIR/$BRAIN_PLIST" ]; then
    rm "$LAUNCH_DIR/$BRAIN_PLIST"
    echo "[+] Removed $LAUNCH_DIR/$BRAIN_PLIST"
else
    echo "[=] $BRAIN_PLIST not found in $LAUNCH_DIR"
fi

echo ""
echo "=== Done ==="
echo "Services unloaded and plists removed."
echo "Log files in logs/ were NOT deleted."
