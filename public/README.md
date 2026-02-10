# Razor Visual Cortex

## Overview

The Visual Cortex provides a real-time 3D visualization of Razor's voice pipeline via the Sphere UI.

## Quick Start
```bash
# Terminal 1: Start bridge server
node src/visual-cortex-bridge.js

# Browser: Open launcher
open public/index.html
```

## Sphere View (`razor-sphere.html`)

**Purpose:** Visual presentation, demos, and real-time monitoring

**Features:**
- 3D flowing wave visualization
- State-driven color transitions (blue > teal > amber > purple)
- Energy-responsive wave animations
- Transcription overlay
- Demo mode with realistic conversation

**Best for:**
- LinkedIn clips and external demos
- Visual presentations
- Client showcases
- Real-time voice pipeline monitoring

**Controls:**
- State buttons (IDLE, LISTEN, THINK, SPEAK)
- Demo button (automated conversation sequence)

## Architecture
```
Bridge Server (port 3333)
    | WebSocket
    |-- Sphere UI (3D visualization)
```

The Sphere UI connects to the bridge server and receives events in real-time.

## Message Types

| Type | Description | UI Response |
|------|-------------|-------------|
| `state` | Pipeline state change | Updates colors and wave behavior |
| `energy` | Audio energy level (0.0-1.0) | Animates wave intensity |
| `transcript` | User or Razor speech | Shows transcription overlay |
| `snapshot` | Full state sync on connect | Initializes UI with current state |

## Usage Scenarios

### LinkedIn Clip
```bash
node src/visual-cortex-bridge.js
open public/razor-sphere.html
# Click Demo button, screen record the visualization
```

### Live Pipeline Monitoring
```bash
node src/visual-cortex-bridge.js
open public/razor-sphere.html
# Run voice pipeline in another terminal
node src/index.js
# Watch live state changes and transcriptions
```

## Integration with Voice Pipeline

To send events from the voice pipeline to the Visual Cortex:
```javascript
import bridge from './visual-cortex-bridge.js';

bridge.start(3333);

// State changes
bridge.setState('LISTENING');

// Audio energy
bridge.setEnergy(rms); // 0.0-1.0

// Transcriptions
bridge.showTranscript('user', 'What deals are closing?');
bridge.showTranscript('razor', '3 deals closing Friday.');
```

## Testing Without Voice Pipeline

The Sphere has a built-in demo mode — click the "DEMO" button.

The bridge server also runs a continuous demo when started standalone:
```bash
node src/visual-cortex-bridge.js
# Automatically broadcasts demo events every 15 seconds
```

## Troubleshooting

**UI shows "Disconnected":** Bridge server not running. Start with `node src/visual-cortex-bridge.js`

**Port 3333 already in use:**
```bash
lsof -ti:3333 | xargs kill -9
node src/visual-cortex-bridge.js
```

**Waves not animating:** No energy events being broadcast. Use demo mode to verify UI works, or check `curl http://localhost:3333/health`

## Health Monitoring
```bash
curl http://localhost:3333/health   # Bridge health
curl http://localhost:3333/stats    # Detailed stats
```
