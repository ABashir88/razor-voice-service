Razor Voice Service

Experimental Voice AI Pipeline for Real-Time Conversational Systems

Razor Voice Service is an experimental voice AI pipeline designed to simulate how conversational voice agents operate in real-time communications environments.

The project explores the architecture behind modern voice AI assistants, conversational AI systems, and AI-powered contact center automation. It demonstrates how speech recognition, wake-word detection, real-time audio processing, and text-to-speech synthesis can be orchestrated into a responsive conversational pipeline.

The system integrates modern voice infrastructure providers such as Deepgram, Telnyx, and ElevenLabs to replicate the types of pipelines commonly used in production conversational AI platforms.

Key Capabilities

Streaming speech recognition (STT)

Wake word detection

Real-time voice activity detection (VAD)

Interruption / barge-in handling

Dynamic TTS pacing

Bluetooth device monitoring

Low-latency conversational voice pipeline orchestration

This project is intended as an architecture exploration of voice AI pipelines, not a production voice assistant.

Architecture
┌──────────────────────────────────────────────────────────────┐
│                     Voice Pipeline                           │
│                                                              │
│  ┌─────────┐   ┌─────┐   ┌───────────┐   ┌──────────────┐     │
│  │Bluetooth│──▶│ Mic │──▶│    VAD    │──▶│  Wake Word   │     │
│  │ Monitor │   │ Sox │   │ (energy)  │   │  Detector    │     │
│  └─────────┘   └─────┘   └───────────┘   └──────┬───────┘     │
│                   ▲                              │             │
│                   │                              ▼             │
│  ┌─────────────┐  │  ┌────────────┐   ┌─────────────────┐     │
│  │ Interruption│  │  │  Deepgram  │◀──│   Command       │     │
│  │  Handler    │──┘  │ Stream STT │   │   Capture       │     │
│  └──────┬──────┘     └─────┬──────┘   └─────────────────┘     │
│         │                  │                                   │
│         ▼                  ▼                                   │
│  ┌─────────────┐   ┌────────────┐                             │
│  │   afplay    │◀──│ TTS Engine │◀── pipeline.speak()         │
│  │ (speakers)  │   │Telnyx/11L  │                             │
│  └─────────────┘   └────────────┘                             │
└──────────────────────────────────────────────────────────────┘
Voice Loop
Audio Input → VAD → Wake Word Detection → STT → Command Processing → TTS → Playback

The pipeline continuously cycles between listening and responding while supporting interruption detection and feedback-loop prevention.

Voice Pipeline State Machine
IDLE → LISTENING → PROCESSING → SPEAKING → LISTENING
            ▲                        │
            └──── (interruption) ────┘

Pipeline behavior:

Wait for voice input

Detect wake word

Capture spoken command

Process command

Generate spoken response

Allow interruption during playback

Setup
Prerequisites (macOS)
brew install sox blueutil switchaudio-osx

These tools provide:

microphone capture

Bluetooth device monitoring

audio device switching

Install
cd /Users/alrazi/razor-voice-service
npm install
cp .env.example .env
npm run setup

The setup script verifies dependencies and environment configuration.

Configure .env
Required API Keys
DEEPGRAM_API_KEY
TELNYX_API_KEY

or

ELEVENLABS_API_KEY
Optional
PORCUPINE_ACCESS_KEY

Enables on-device wake word detection using Picovoice Porcupine.

Run

Start the pipeline:

npm start

Development mode:

npm run dev
Test Individual Components
Bluetooth Connectivity
npm run test:bluetooth
Microphone + VAD Visualization
npm run test:mic
TTS + Playback
npm run test:playback

These scripts validate each stage of the audio pipeline independently.

Wake Word Detection

Two strategies are supported.

1. VAD + Transcript Fallback (Default)

Pipeline:

Mic → VAD → Deepgram STT → Keyword Detection

Characteristics:

No additional setup required

Uses transcription to detect wake word

~500ms latency

2. Porcupine On-Device Detection

When PORCUPINE_ACCESS_KEY is configured:

real-time keyword detection

~50ms latency

fully on-device processing

Train custom keywords at:

https://console.picovoice.ai

Place the model file here:

models/razor_mac.ppn
Interruption Handling (Barge-In)

During playback:

Microphone is muted to prevent feedback

Interruption handler monitors raw audio energy

If speech is detected:

kill playback immediately
unmute microphone
return to listening state

This replicates barge-in behavior used in conversational voice assistants.

Feedback Loop Prevention

To prevent speaker output from triggering the microphone:

Mic mutes when playback begins

Mic unmutes 300ms after playback ends

Configurable via:

PLAYBACK_MUTE_BUFFER_MS
Bluetooth Monitoring

The system monitors the Ortizan X8 Pro Bluetooth microphone.

Features:

connection polling every 60 seconds

automatic reconnection attempts

automatic macOS audio routing

event-driven pipeline pause/resume

This simulates device monitoring used in real-time voice systems.

Dynamic Speech Pacing
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

This repository explores AI-powered voice systems and real-time conversational infrastructure.

It demonstrates how modern voice AI stacks combine:

speech recognition

real-time audio processing

conversational orchestration

synthetic voice generation

to create responsive conversational agents.

The goal is to better understand architecture patterns behind modern voice AI systems used across conversational AI platforms, AI assistants, and voice-enabled applications.
