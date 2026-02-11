#!/bin/bash
# watchdog.sh — Health check watchdog for Razor services
# Checks http://localhost:3000/health every invocation.
# Tracks consecutive failures. After 3 failures, restarts services.
#
# Install in crontab:
#   */5 * * * * /Users/alrazibashir/razor-voice-service/scripts/watchdog.sh

set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$PROJECT_DIR/logs"
LOG_FILE="$LOG_DIR/watchdog.log"
FAIL_FILE="$LOG_DIR/.watchdog-failures"
HEALTH_URL="http://127.0.0.1:3000/health"
MAX_FAILURES=3

mkdir -p "$LOG_DIR"

ts() {
    date '+%Y-%m-%d %H:%M:%S'
}

log() {
    echo "$(ts) $1" >> "$LOG_FILE"
}

# Read current failure count
failures=0
if [ -f "$FAIL_FILE" ]; then
    failures=$(cat "$FAIL_FILE" 2>/dev/null || echo 0)
fi

# Health check with 5s timeout
response=$(curl -sf --max-time 5 "$HEALTH_URL" 2>/dev/null)

if [ $? -eq 0 ] && echo "$response" | grep -q '"status":"ok"'; then
    # Healthy — reset failure count
    if [ "$failures" -gt 0 ]; then
        log "[OK] Service recovered after $failures failure(s)"
    fi
    echo 0 > "$FAIL_FILE"
    exit 0
fi

# Failed
failures=$((failures + 1))
echo "$failures" > "$FAIL_FILE"
log "[WARN] Health check failed ($failures/$MAX_FAILURES)"

if [ "$failures" -ge "$MAX_FAILURES" ]; then
    log "[ACTION] $MAX_FAILURES consecutive failures — restarting services"

    UID_NUM="$(id -u)"

    # Restart voice service
    launchctl kickstart -k "gui/$UID_NUM/com.razor.voice" 2>/dev/null
    if [ $? -eq 0 ]; then
        log "[RESTART] com.razor.voice restarted"
    else
        log "[ERROR] Failed to restart com.razor.voice"
    fi

    # Restart brain service
    launchctl kickstart -k "gui/$UID_NUM/com.razor.brain" 2>/dev/null
    if [ $? -eq 0 ]; then
        log "[RESTART] com.razor.brain restarted"
    else
        log "[ERROR] Failed to restart com.razor.brain"
    fi

    # Reset counter after restart attempt
    echo 0 > "$FAIL_FILE"
    log "[OK] Restart complete — counter reset"
fi
