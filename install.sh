#!/bin/bash
# ═══════════════════════════════════════════════════════
#   RAZOR VOICE SERVICE v2.0 — Installer
#   Ortizan X8 Pro + Telnyx STT/TTS + OpenClaw Gateway
# ═══════════════════════════════════════════════════════

set -e

SERVICE_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="$(which node)"
PLIST_NAME="com.razor.voice"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"

echo ""
echo "  ═══════════════════════════════════════════════════"
echo "  🔪  RAZOR VOICE SERVICE v2.0 — INSTALLER"
echo "  ═══════════════════════════════════════════════════"
echo ""

# ── Prerequisites ──
echo "  Checking prerequisites..."

if ! command -v node &>/dev/null; then echo "  ❌ Node.js required"; exit 1; fi
echo "  ✅ Node.js $(node --version)"

if ! command -v rec &>/dev/null; then echo "  ❌ sox required (brew install sox)"; exit 1; fi
echo "  ✅ sox/rec"

if ! command -v afplay &>/dev/null; then echo "  ❌ afplay required (macOS only)"; exit 1; fi
echo "  ✅ afplay"

if ! command -v SwitchAudioSource &>/dev/null; then echo "  ❌ switchaudio-osx required (brew install switchaudio-osx)"; exit 1; fi
echo "  ✅ SwitchAudioSource"

if ! command -v blueutil &>/dev/null; then echo "  ❌ blueutil required (brew install blueutil)"; exit 1; fi
echo "  ✅ blueutil"

if [ -z "$TELNYX_API_KEY" ]; then
  echo "  ❌ TELNYX_API_KEY not set"
  echo "     export TELNYX_API_KEY=\"KEY...\""
  exit 1
fi
echo "  ✅ Telnyx API key"

echo ""

# ── Bluetooth Check ──
echo "  Checking Ortizan X8 Pro..."
BT_MAC="1c-2c-e0-05-1a-84"
if blueutil --is-connected "$BT_MAC" 2>/dev/null | grep -q "1"; then
  echo "  ✅ Ortizan X8 Pro: connected"
else
  echo "  ⚠️  Ortizan X8 Pro: not connected — attempting..."
  blueutil --connect "$BT_MAC" 2>/dev/null || true
  sleep 3
  if blueutil --is-connected "$BT_MAC" 2>/dev/null | grep -q "1"; then
    echo "  ✅ Ortizan X8 Pro: connected"
  else
    echo "  ⚠️  Could not connect. Service will retry automatically."
  fi
fi

# Set audio routing
SwitchAudioSource -t input -s "X8 Pro" 2>/dev/null && echo "  ✅ Input: X8 Pro" || echo "  ⚠️  Input routing failed"
SwitchAudioSource -t output -s "X8 Pro" 2>/dev/null && echo "  ✅ Output: X8 Pro" || echo "  ⚠️  Output routing failed"

# Test mic
if rec -q -c 1 -r 16000 -b 16 -t wav /dev/null trim 0 0.1 2>/dev/null; then
  echo "  ✅ Microphone working"
else
  echo "  ⚠️  Microphone not responding"
fi

echo ""

# ── Stop Old Services ──
echo "  Stopping existing services..."
launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl unload "$HOME/Library/LaunchAgents/com.razor.voice-desk.plist" 2>/dev/null || true
pkill -f "razor-voice-service/main.js" 2>/dev/null || true
pkill -f "desk-assistant.mjs" 2>/dev/null || true
sleep 1
echo "  ✅ Clean"

# ── LaunchAgent ──
echo "  Installing LaunchAgent..."
mkdir -p "$HOME/Library/LaunchAgents"

cat > "$PLIST_PATH" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_NAME}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${SERVICE_DIR}/main.js</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/razor-voice.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/razor-voice-err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>TELNYX_API_KEY</key>
    <string>${TELNYX_API_KEY}</string>
    <key>HOME</key>
    <string>${HOME}</string>
  </dict>
  <key>ThrottleInterval</key>
  <integer>5</integer>
</dict>
</plist>
PLIST

echo "  ✅ LaunchAgent installed"

# ── PTT Script ──
cat > "${SERVICE_DIR}/ptt.sh" << 'SCRIPT'
#!/bin/bash
curl -s http://127.0.0.1:3457/ptt 2>/dev/null
SCRIPT
chmod +x "${SERVICE_DIR}/ptt.sh"

# ── Automator Quick Action ──
WORKFLOW_DIR="$HOME/Library/Services/Razor PTT.workflow/Contents"
mkdir -p "$WORKFLOW_DIR"
cat > "$WORKFLOW_DIR/document.wflow" << 'WFLOW'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>AMApplication</key><string>Automator</string>
  <key>AMCanShowWhenRun</key><false/>
  <key>AMDefaultRecordedInput</key><string>Text</string>
  <key>AMWorkflowDescription</key><dict>
    <key>AMDInput</key><string>no input</string>
    <key>AMDApplication</key><array><string>any application</string></array>
  </dict>
  <key>actions</key>
  <array>
    <dict>
      <key>action</key>
      <dict>
        <key>AMAccepts</key><dict><key>Container</key><string>List</string><key>Optional</key><true/><key>Types</key><array><string>com.apple.cocoa.string</string></array></dict>
        <key>AMActionVersion</key><string>2.0.3</string>
        <key>AMParameterProperties</key><dict><key>COMMAND_STRING</key><dict/><key>CheckedForUserDefaultShell</key><dict/><key>inputMethod</key><dict/><key>shell</key><dict/><key>source</key><dict/></dict>
        <key>AMProvides</key><dict><key>Container</key><string>List</string><key>Types</key><array><string>com.apple.cocoa.string</string></array></dict>
        <key>ActionBundlePath</key><string>/System/Library/Automator/Run Shell Script.action</string>
        <key>ActionName</key><string>Run Shell Script</string>
        <key>BundleIdentifier</key><string>com.apple.RunShellScript</string>
        <key>CFBundleVersion</key><string>2.0.3</string>
        <key>CanShowSelectedItemsWhenRun</key><false/>
        <key>CanShowWhenRun</key><true/>
        <key>Category</key><array><string>AMCategoryUtilities</string></array>
        <key>Class Name</key><string>RunShellScriptAction</string>
        <key>InputUUID</key><string>0</string>
        <key>Keywords</key><array><string>Shell</string><string>Script</string><string>Command</string><string>Run</string><string>Unix</string></array>
        <key>OutputUUID</key><string>0</string>
        <key>UUID</key><string>1</string>
        <key>UnlocalizedApplications</key><array><string>Automator</string></array>
      </dict>
      <key>isViewVisible</key><true/>
      <key>location</key><string>300.000000:253.000000</string>
      <key>nibPath</key><string>/System/Library/Automator/Run Shell Script.action/Contents/Resources/Base.lproj/main.nib</string>
      <key>parameters</key>
      <dict>
        <key>COMMAND_STRING</key><string>curl -s http://127.0.0.1:3457/ptt</string>
        <key>CheckedForUserDefaultShell</key><true/>
        <key>inputMethod</key><integer>1</integer>
        <key>shell</key><string>/bin/bash</string>
        <key>source</key><string></string>
      </dict>
    </dict>
  </array>
</dict>
</plist>
WFLOW
echo "  ✅ Keyboard shortcut: Razor PTT (Automator)"

# ── Shell Alias ──
if ! grep -q 'alias ptt=' "$HOME/.zshrc" 2>/dev/null; then
  echo "" >> "$HOME/.zshrc"
  echo "# Razor Voice PTT" >> "$HOME/.zshrc"
  echo 'alias ptt="curl -s http://127.0.0.1:3457/ptt"' >> "$HOME/.zshrc"
  echo "  ✅ Shell alias: ptt"
else
  echo "  ✅ Shell alias: ptt (exists)"
fi

# ── Start Service ──
echo ""
echo "  Starting Razor Voice Service..."
launchctl load "$PLIST_PATH"
sleep 3

if launchctl list | grep -q "$PLIST_NAME"; then
  PID=$(launchctl list | grep "$PLIST_NAME" | awk '{print $1}')
  echo "  ✅ Running (PID: $PID)"
else
  echo "  ⚠️  May not have started — check: tail -f /tmp/razor-voice.log"
fi

# Quick health check
sleep 2
HEALTH=$(curl -s http://127.0.0.1:3457/health 2>/dev/null)
if echo "$HEALTH" | grep -q '"ok":true'; then
  echo "  ✅ Health: OK"
  echo "  $HEALTH"
else
  echo "  ⚠️  Health check pending — service may still be starting"
fi

echo ""
echo "  ═══════════════════════════════════════════════════"
echo "  🔪  RAZOR VOICE SERVICE v2.0 — INSTALLED"
echo "  ═══════════════════════════════════════════════════"
echo ""
echo "  Audio:     Ortizan X8 Pro (Bluetooth)"
echo "  Voice:     Telnyx KokoroTTS am_adam"
echo "  Logs:      tail -f /tmp/razor-voice.log"
echo "  Health:    curl localhost:3457/health"
echo "  Status:    curl localhost:3457/status"
echo "  PTT:       ptt  (or Cmd+Shift+R after setup)"
echo "  Stop:      launchctl unload $PLIST_PATH"
echo ""
echo "  TO SET UP Cmd+Shift+R:"
echo "  System Settings → Keyboard → Keyboard Shortcuts → Services"
echo "  Find 'Razor PTT' → assign Cmd+Shift+R"
echo ""
echo "  INTERACTIVE MODE (SPACE bar PTT):"
echo "  TELNYX_API_KEY=\$TELNYX_API_KEY node ${SERVICE_DIR}/main.js"
echo ""
