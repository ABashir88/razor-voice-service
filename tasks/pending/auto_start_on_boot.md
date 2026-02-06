Read CLAUDE.md. Execute this task:

TASK: Make Razor and Brain auto-start on Mac Mini boot

FILES: Create new files in scripts/

IMPLEMENTATION:

1. Create a startup script (scripts/start-razor.sh):
   - Starts brain server in background
   - Waits for brain to be healthy (curl health endpoint)
   - Starts Razor (npm start)
   - Auto-restarts either if they crash

2. Create launchd plist for Mac Mini auto-start:
   - ~/Library/LaunchAgents/com.razor.assistant.plist
   - Runs start-razor.sh on login
   - Restarts on failure

3. Create a stop script (scripts/stop-razor.sh):
   - Gracefully stops both services

4. Create a restart script (scripts/restart-razor.sh):
   - Stop then start

STARTUP SCRIPT LOGIC:
```bash
#!/bin/bash
# Start brain
cd ~/razor-voice-service/brain
python3 -m razor_brain.server &
BRAIN_PID=$!

# Wait for brain health
until curl -s http://127.0.0.1:8780/health > /dev/null; do
  sleep 1
done

# Start Razor
cd ~/razor-voice-service
npm start
```

SUCCESS CRITERIA:
- `./scripts/start-razor.sh` starts everything
- Reboot Mac Mini → Razor running automatically
- If brain crashes → auto-restarts
- If Razor crashes → auto-restarts

Say "TASK COMPLETE" when done.
