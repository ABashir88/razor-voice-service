# Razor Voice Service

Always-listening voice agent with wake word detection, interruption handling, and dynamic TTS pacing.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     Voice Pipeline                           │
│                                                              │
│  ┌─────────┐   ┌─────┐   ┌───────────┐   ┌──────────────┐  │
│  │Bluetooth│──▶│ Mic │──▶│    VAD    │──▶│  Wake Word   │  │
│  │ Monitor │   │ Sox │   │ (energy)  │   │  Detector    │  │
│  └─────────┘   └─────┘   └───────────┘   └──────┬───────┘  │
│                   ▲                              │           │
│                   │                              ▼           │
│  ┌─────────────┐  │  ┌────────────┐   ┌─────────────────┐  │
│  │ Interruption│  │  │  Deepgram  │◀──│   Command       │  │
│  │  Handler    │──┘  │ Stream STT │   │   Capture       │  │
│  └──────┬──────┘     └─────┬──────┘   └─────────────────┘  │
│         │                  │                                 │
│         ▼                  ▼                                 │
│  ┌─────────────┐   ┌────────────┐                           │
│  │   afplay    │◀──│ TTS Engine │◀── pipeline.speak()       │
│  │ (speakers)  │   │Telnyx/11L  │                           │
│  └─────────────┘   └────────────┘                           │
└──────────────────────────────────────────────────────────────┘
```

## State Machine

```
IDLE → LISTENING → PROCESSING → SPEAKING → LISTENING
            ▲                        │
            └──── (interruption) ────┘
```

## Setup

### Prerequisites (macOS)

```bash
brew install sox blueutil switchaudio-osx
```

### Install

```bash
cd /Users/alrazi/razor-voice-service
npm install
cp .env.example .env    # fill in API keys
npm run setup           # verify dependencies
```

### Configure `.env`

Required keys:
- `DEEPGRAM_API_KEY` – for VAD fallback wake word + streaming STT
- `TELNYX_API_KEY` or `ELEVENLABS_API_KEY` – for TTS

Optional:
- `PORCUPINE_ACCESS_KEY` – enables on-device wake word (faster, no API call)

### Run

```bash
npm start       # production
npm run dev     # auto-reload on changes
```

### Test Individual Components

```bash
npm run test:bluetooth   # verify Ortizan X8 Pro connection
npm run test:mic         # 10s recording with VAD visualization
npm run test:playback    # TTS synthesis + afplay test
```

## Wake Word Detection

Two strategies, auto-selected based on config:

### 1. VAD + Transcript Fallback (default)
- Mic → VAD detects speech → send to Deepgram batch STT → check for "razor"
- Works immediately, no special setup
- ~500ms latency per check

### 2. Porcupine On-Device (when API key arrives)
- Real-time PCM processing, ~50ms latency
- Set `PORCUPINE_ACCESS_KEY` in `.env`
- Optionally train custom "Razor" keyword at console.picovoice.ai
- Place `.ppn` file at `models/razor_mac.ppn`

## Interruption Handling

During TTS playback:
1. Mic is muted (feedback loop prevention)
2. Interruption handler monitors raw audio energy (bypasses mute)
3. If speech detected (3 consecutive frames above threshold): kill afplay immediately
4. Unmute mic with NO delay (immediate for responsiveness)
5. Pipeline returns to LISTENING state

## Feedback Loop Prevention

1. Mic mutes when playback starts
2. Mic unmutes 300ms AFTER playback ends (configurable via `PLAYBACK_MUTE_BUFFER_MS`)
3. The 300ms buffer absorbs residual speaker audio picked up by the Bluetooth mic

## Bluetooth Monitoring

- Polls Ortizan X8 Pro connection every 60s via `blueutil`
- Auto-reconnects on disconnect (up to 10 attempts)
- Auto-sets macOS audio input to Bluetooth HFP device
- Auto-sets macOS audio output to Mac Mini speakers
- Emits events so pipeline can pause/resume

## Dynamic Pacing

| Pace | Speed | Pitch | Trigger |
|------|-------|-------|---------|
| urgent | 1.15× | +2st | Time-sensitive alerts |
| normal | 1.0× | +0st | Default |
| calm | 0.9× | −1st | After 10pm, bedtime |

## File Structure

```
src/
├── index.js                    # Entry point + command handler
├── config.js                   # Central configuration
├── audio/
│   ├── capture.js              # Mic recording via sox
│   ├── playback.js             # afplay with interruption support
│   └── bluetooth.js            # Ortizan X8 Pro monitor
├── vad/
│   └── vad-engine.js           # Energy-based voice activity detection
├── wake-word/
│   ├── index.js                # Strategy selector
│   ├── transcript-detector.js  # VAD→STT→keyword check fallback
│   └── porcupine-detector.js   # On-device Porcupine (swap-in ready)
├── stt/
│   └── deepgram-stream.js      # Streaming STT for command capture
├── tts/
│   └── tts-engine.js           # Telnyx + ElevenLabs TTS
├── pipeline/
│   ├── voice-pipeline.js       # Main orchestrator
│   └── interruption-handler.js # Detect speech during playback
└── utils/
    ├── logger.js               # Colored structured logging
    ├── setup.js                # Dependency checker
    ├── test-mic.js             # Mic + VAD test
    ├── test-playback.js        # TTS + afplay test
    └── test-bluetooth.js       # Bluetooth connection test
```
