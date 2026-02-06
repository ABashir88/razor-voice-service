Read CLAUDE.md. Execute this task:

TASK: Fix echo/feedback loop - mic is capturing Razor's own audio output

PROBLEM: 
1. Acknowledgment "Yes?" plays, mic captures it, STT includes it in transcript
2. VAD shows 25+ seconds of "speech" because it's hearing playback
3. User has to repeat themselves multiple times

FILES: src/audio/capture.js, src/pipeline/voice-pipeline.js, src/playback/

FIXES:

1. MUTE MIC DURING PLAYBACK:
   - Before TTS playback starts, pause/mute the mic capture
   - After playback finishes, resume mic capture
   - Add 200ms buffer after playback before resuming mic

2. STATE-BASED MIC CONTROL:
   - LISTENING state: mic active
   - SPEAKING state: mic muted
   - PROCESSING state: mic can be active

3. CLEAR BUFFERS AFTER PLAYBACK:
   - After playback finishes, clear any pending VAD/STT buffers
   - Fresh start for next command

SUCCESS CRITERIA:
- "Razor, I just got off a call with Marcus" → clean capture, no echo
- Transcript does NOT include "Yes?" or repeated phrases
- VAD shows 2-5 seconds speech, not 25+
- Works first time, no repeating

Say "TASK COMPLETE" when done.
