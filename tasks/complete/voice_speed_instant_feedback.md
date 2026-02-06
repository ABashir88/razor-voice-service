Read CLAUDE.md. Execute this task:

TASK: Make Razor lightning fast with instant feedback

TARGET: Wake word to first audio < 1.5 seconds. User speaks normally, no yelling.

FILES: src/config.js, src/tts/tts-engine.js, src/audio/capture.js, src/vad/vad-engine.js, src/index.js, src/pipeline/voice-pipeline.js

FIXES:

1. MICROPHONE SENSITIVITY:
   - In capture.js, add gain to sox recording options
   - Lower VAD speechThreshold to 0.25 in config.js

2. INSTANT ACKNOWLEDGMENT:
   - When wake word detected, IMMEDIATELY play a short audio cue
   - Create quick acknowledgments: "Yeah?" / "Yep?" / "What's up?"
   - Play instantly (<100ms) before processing starts

3. FASTER TTS:
   - Set Telnyx TTS timeout to 2000ms (fail fast)
   - Truncate responses over 300 chars before TTS

4. REMOVE DOUBLE-PROCESSING (src/index.js):
   - Skip second brain call for enriched response
   - Brain → fetch data → format directly → speak

SUCCESS CRITERIA:
- Wake word → acknowledgment < 200ms
- Wake word → full response < 2 seconds
- Normal speaking volume works

Say "TASK COMPLETE" when done.
