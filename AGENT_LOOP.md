# Razor Continuous Improvement Agent

## MISSION
Continuously improve Razor until it is a production-grade 24/7 AI sales voice assistant.

## COMPONENTS TO OPTIMIZE

### 1. VOICE PIPELINE (src/pipeline/, src/audio/, src/vad/, src/wake-word/, src/stt/, src/tts/)
SUCCESS CRITERIA:
- Wake word "Razor" detected within 500ms
- Full sentences captured without fragmentation (2s silence threshold)
- No idle timeout - always listening
- TTS speaks clearly through configured audio device
- Interruption works - saying "Razor" during speech stops playback

### 2. BRAIN (brain/razor_brain/)
SUCCESS CRITERIA:
- Responds in < 3 seconds
- Extracts entities (names, companies) correctly
- Returns actionable intents (greeting, question, objection, action_request, closing)
- Suggests relevant actions (log_call, research, send_email)
- Never returns raw JSON to TTS - only clean text

### 3. MEMORY (src/memory/)
SUCCESS CRITERIA:
- Working memory tracks conversation turns
- Semantic memory stores contacts and companies mentioned
- Episodic memory logs completed conversations
- Learning loop triggers on conversation end
- Context persists across interactions

### 4. INTEGRATIONS (src/integrations/)
SUCCESS CRITERIA:
- Graceful degradation when services unavailable
- Actions dispatched correctly (log_call creates Salesforce task)
- Contact lookup works across Salesforce + Salesloft
- No crashes on API failures

### 5. STATE MACHINE (src/state/)
SUCCESS CRITERIA:
- Clean transitions: LISTENING → PROCESSING → SPEAKING → LISTENING
- No stuck states
- LEARNING triggers memory reflection
- INTERRUPTED handles barge-in correctly

## COMPLETION CRITERIA
Razor is production-ready when ALL of these work:
- 10 consecutive voice commands processed correctly
- No sentence fragmentation in any test
- No unexpected state transitions
- Memory persists contact "Marcus" and company "Clearwater Capital"
- Brain responds contextually to follow-up questions
- System runs for 10+ minutes without errors

Say "RAZOR PRODUCTION READY" when all criteria pass.
