# Razor Voice Service

**Experimental Voice AI Pipeline for Real-Time Conversational Systems**

Razor Voice Service is an experimental voice AI pipeline designed to simulate how conversational voice agents operate in real-time communications environments.

The project explores the architecture behind modern **voice AI assistants, conversational AI systems, and AI-powered contact center automation**. It demonstrates how speech recognition, wake-word detection, real-time audio processing, and text-to-speech synthesis can be orchestrated into a responsive conversational pipeline.

The system integrates modern voice infrastructure providers such as **Deepgram, Telnyx, and ElevenLabs** to replicate the types of pipelines commonly used in production conversational AI platforms.

---

## Key Capabilities

- Streaming speech recognition (STT)
- Wake word detection
- Real-time voice activity detection (VAD)
- Interruption / barge-in handling
- Dynamic TTS pacing
- Bluetooth device monitoring
- Low-latency conversational voice pipeline orchestration

> This project is intended as an **architecture exploration of voice AI pipelines**, not a production voice assistant.

---

## Architecture
```text
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

### Voice Loop
```text
Audio Input → VAD → Wake Word Detection → STT → Command Processing → TTS → Playback
```

The pipeline continuously cycles between listening and responding while supporting interruption detection and feedback-loop prevention.

---

## Voice Pipeline State Machine
```text
IDLE → LISTENING → PROCESSING → SPEAKING → LISTENING
            ▲                        │
            └──── (interruption) ────┘
```

1. Wait for voice input
2. Detect wake word
3. Capture spoken command
4. Process command
5. Generate spoken response
6. Allow interruption during playback

---

## Setup

### Prerequisites (macOS)
```bash
brew install sox blueutil switchaudio-osx
```

These provide microphone capture, Bluetooth device monitoring, and audio device switching.

### Install
```bash
cd /Users/alrazi/razor-voice-service
npm install
cp .env.example .env
npm run setup
```

The setup script verifies dependencies and environment configuration.

---

## Configure `.env`

**Required API Keys**
```
DEEPGRAM_API_KEY
TELNYX_API_KEY
```

or
```
ELEVENLABS_API_KEY
```

**Optional**
```
PORCUPINE_ACCESS_KEY
```

Enables on-device wake word detection using Picovoice Porcupine.

---

## Run
```bash
# Start the pipeline
npm start

# Development mode
npm run dev
```

---

## Test Individual Components
```bash
# Bluetooth connectivity
npm run test:bluetooth

# Microphone + VAD visualization
npm run test:mic

# TTS + playback
npm run test:playback
```

These scripts validate each stage of the audio pipeline independently.

---

## Wake Word Detection

### 1. VAD + Transcript Fallback (Default)
```text
Mic → VAD → Deepgram STT → Keyword Detection
```

- No additional setup required
- Uses transcription to detect wake word
- ~500ms latency

### 2. Porcupine On-Device Detection

When `PORCUPINE_ACCESS_KEY` is configured:

- Real-time keyword detection
- ~50ms latency
- Fully on-device processing

Train custom keywords at [console.picovoice.ai](https://console.picovoice.ai) and place the model file at:
```bash
models/razor_mac.ppn
```

---

## Interruption Handling (Barge-In)

During playback:

1. Microphone is muted to prevent feedback
2. Interruption handler monitors raw audio energy
3. If speech is detected — kill playback immediately, unmute microphone, return to listening state

This replicates **barge-in behavior used in conversational voice assistants**.

---

## Feedback Loop Prevention

To prevent speaker output from triggering the microphone:

1. Mic mutes when playback begins
2. Mic unmutes **300ms after playback ends**

Configurable via `PLAYBACK_MUTE_BUFFER_MS`. This buffer absorbs residual speaker audio captured by the Bluetooth microphone.

---

## Bluetooth Monitoring

The system monitors the **Ortizan X8 Pro Bluetooth microphone** with:

- Connection polling every 60 seconds
- Automatic reconnection attempts
- Automatic macOS audio routing
- Event-driven pipeline pause/resume

---

## Dynamic Speech Pacing

| Pace   | Speed | Pitch | Use Case          |
|--------|-------|-------|-------------------|
| urgent | 1.15× | +2st  | Alerts            |
| normal | 1.0×  | +0st  | Default           |
| calm   | 0.9×  | −1st  | Evening responses |

---

## File Structure
```text
src/
├── index.js
├── config.js
├── audio/
│   ├── capture.js
│   ├── playback.js
│   └── bluetooth.js
├── vad/
│   └── vad-engine.js
├── wake-word/
│   ├── index.js
│   ├── transcript-detector.js
│   └── porcupine-detector.js
├── stt/
│   └── deepgram-stream.js
├── tts/
│   └── tts-engine.js
├── pipeline/
│   ├── voice-pipeline.js
│   └── interruption-handler.js
└── utils/
    ├── logger.js
    ├── setup.js
    ├── test-mic.js
    ├── test-playback.js
    └── test-bluetooth.js
```

---

## Purpose

This repository explores **AI-powered voice systems and real-time conversational infrastructure**. It demonstrates how modern voice AI stacks combine speech recognition, real-time audio processing, conversational orchestration, and synthetic voice generation to create responsive conversational agents.

The goal is to better understand **architecture patterns behind modern voice AI systems** used across conversational AI platforms, AI assistants, and voice-enabled applications.
