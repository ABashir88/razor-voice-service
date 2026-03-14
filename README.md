Razor Voice Service

Experimental Voice AI Pipeline for Real-Time Conversational Systems

Razor Voice Service is an experimental voice AI pipeline designed to simulate how conversational voice agents operate in real-time communications environments.

The project explores the architecture behind modern voice AI assistants, conversational AI systems, and AI-powered contact center automation. It demonstrates how speech recognition, wake-word detection, real-time audio processing, and text-to-speech synthesis can be orchestrated into a responsive conversational pipeline.

The system integrates modern voice infrastructure providers such as Deepgram, Telnyx, and ElevenLabs to replicate the types of pipelines commonly used in production conversational AI platforms.

Key capabilities demonstrated:

streaming speech recognition (STT)

wake word detection

real-time voice activity detection (VAD)

interruption (barge-in) handling

dynamic TTS pacing

Bluetooth device monitoring

low-latency conversational voice pipeline orchestration

This project is intended as an architecture exploration of voice AI pipelines, not a production voice assistant.

Architecture
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

This architecture demonstrates a real-time conversational voice loop:

Audio Input → Voice Activity Detection → Wake Word Detection → Speech Recognition → Command Processing → Text-to-Speech → Playback

The pipeline continuously cycles through listening and response states while supporting interruption detection and feedback loop prevention.

Voice Pipeline State Machine
IDLE → LISTENING → PROCESSING → SPEAKING → LISTENING
            ▲                        │
            └──── (interruption) ────┘

The pipeline operates as a simple conversational state machine that:

Waits for voice input

Detects the wake word

Captures and processes speech commands

Synthesizes spoken responses

Handles user interruptions during playback

Setup
Prerequisites (macOS)
brew install sox blueutil switchaudio-osx

These tools provide:

microphone capture

Bluetooth device monitoring

audio input/output switching

Install
cd /Users/alrazi/razor-voice-service
npm install
cp .env.example .env
npm run setup

The setup script verifies required dependencies and environment configuration.

Configure .env

Required API keys:

DEEPGRAM_API_KEY
TELNYX_API_KEY

or

ELEVENLABS_API_KEY

Optional:

PORCUPINE_ACCESS_KEY

This enables on-device wake word detection using Picovoice Porcupine.

Run

Start the voice pipeline:

npm start

Development mode with auto-reload:

npm run dev
Test Individual Components

Bluetooth connectivity:

npm run test:bluetooth

Microphone capture + VAD visualization:

npm run test:mic

TTS synthesis + playback:

npm run test:playback

These scripts validate each stage of the audio pipeline independently.

Wake Word Detection

The system supports two wake-word strategies.

1. VAD + Transcript Fallback (Default)

Pipeline:

Mic → Voice Activity Detection → Deepgram Batch STT → Keyword Detection

Characteristics:

No additional setup required

Uses transcription to detect wake word

~500ms latency

2. Porcupine On-Device Wake Word

When PORCUPINE_ACCESS_KEY is configured:

real-time keyword detection

~50ms latency

fully on-device processing

Custom keywords can be trained using:

https://console.picovoice.ai

Place the .ppn model file here:

models/razor_mac.ppn
Interruption Handling (Barge-In)

During speech playback:

Microphone input is muted to prevent feedback

Interruption handler monitors raw audio energy

If user speech is detected:

playback is immediately stopped

microphone is unmuted

pipeline returns to listening state

This replicates barge-in behavior used in conversational voice assistants.

Feedback Loop Prevention

To prevent speaker audio from triggering the microphone:

Mic mutes when playback begins

Mic unmutes 300ms after playback ends

Configurable via:

PLAYBACK_MUTE_BUFFER_MS

This buffer absorbs residual speaker audio captured by the Bluetooth microphone.

Bluetooth Monitoring

The system monitors the Ortizan X8 Pro Bluetooth microphone.

Features:

connection polling every 60 seconds

automatic reconnection attempts

automatic macOS audio routing

event-driven pipeline pause/resume

This simulates device monitoring behavior used in real-time voice applications.

Dynamic Speech Pacing

TTS responses adjust delivery speed based on context.

Pace	Speed	Pitch	Use Case
urgent	1.15×	+2st	alerts
normal	1.0×	+0st	default
calm	0.9×	−1st	evening responses
File Structure
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
Purpose of the Project

This repository is part of an ongoing exploration into AI-powered voice systems and real-time conversational infrastructure.

It demonstrates how modern voice AI stacks combine:

speech recognition

real-time audio processing

conversational orchestration

synthetic voice generation

to create responsive conversational agents.

The goal is to better understand the architecture patterns behind modern voice AI systems used across conversational AI platforms, AI assistants, and voice-enabled applications.
