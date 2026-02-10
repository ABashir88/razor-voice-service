# Visual Cortex Integration Guide

## Overview

The Visual Cortex bridge connects Razor's voice pipeline to the sphere visualization UI (`razor-sphere.html`). It broadcasts real-time state changes, transcriptions, and audio energy over WebSocket on port 3333.

## Quick Start

```bash
# Start bridge with built-in demo simulator
node src/visual-cortex-bridge.js

# Open razor-sphere.html in any browser
# The sphere auto-connects to ws://localhost:3333
```

## Message Types

The sphere UI expects these messages:

| Type | Fields | Purpose |
|------|--------|---------|
| `state` | `{ state: 'IDLE'\|'LISTENING'\|'PROCESSING'\|'SPEAKING' }` | Pipeline state |
| `energy` | `{ rms: 0.0-1.0 }` | Audio energy for wave animation |
| `transcript` | `{ speaker: 'user'\|'razor', text: '...' }` | Transcription display |
| `snapshot` | `{ state, energy }` | Full sync on connect |

## API

```javascript
import bridge from './visual-cortex-bridge.js';

bridge.start(3333);                              // Start server
bridge.setState('LISTENING');                     // Change state
bridge.setEnergy(0.5);                            // Audio energy (0-1)
bridge.showTranscript('user', 'Check calendar');  // Show transcript
bridge.showTranscript('razor', 'You have 3 meetings today.');
bridge.clearTranscript();                         // Clear display
bridge.stop();                                    // Shutdown
```

## Integration with Voice Pipeline

Add to `src/index.js`:

```javascript
import bridge from './visual-cortex-bridge.js';

// Start bridge alongside voice pipeline
bridge.start(3333);

// Map pipeline state transitions
sm.on('transition', ({ to }) => {
  const map = {
    IDLE: 'IDLE', LISTENING: 'LISTENING',
    PROCESSING: 'PROCESSING', SPEAKING: 'SPEAKING',
    BRIEFING: 'SPEAKING', RESEARCHING: 'PROCESSING',
    COACHING: 'SPEAKING',
  };
  bridge.setState(map[to] || 'IDLE');
});

// STT transcription
pipeline.on('command', ({ text }) => bridge.showTranscript('user', text));

// Brain response
bridge.showTranscript('razor', speakText);

// Audio energy (from VAD or capture)
bridge.setEnergy(rms);
```

## Endpoints

| URL | Purpose |
|-----|---------|
| `ws://localhost:3333` | WebSocket event stream |
| `http://localhost:3333/health` | Health check JSON |
| `http://localhost:3333/stats` | Client stats JSON |
| `http://localhost:3333/` | Status page |

## Testing

```bash
# Terminal 1: bridge + demo
node src/visual-cortex-bridge.js

# Terminal 2: continuous simulator
node scripts/test-bridge-simulator.js

# Health check
curl http://localhost:3333/health
```

## Notes

- Bridge is standalone — voice pipeline works without it
- Port 3333 matches razor-sphere.html default
- Energy updates fire at ~50ms intervals during speech
- Non-energy messages logged; energy suppressed to avoid spam
