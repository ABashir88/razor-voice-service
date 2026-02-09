// src/config.js – Central configuration for Razor Voice Service
import { config as dotenvConfig } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');

dotenvConfig({ path: join(ROOT, '.env') });

function env(key, fallback) {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return v;
}

function envInt(key, fallback) {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? fallback : n;
}

function envFloat(key, fallback) {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = parseFloat(v);
  return Number.isNaN(n) ? fallback : n;
}

const config = Object.freeze({
  root: ROOT,

  // ── Audio ──
  audio: Object.freeze({
    sampleRate: envInt('SAMPLE_RATE', 16000),
    channels: envInt('CHANNELS', 1),
    bitDepth: envInt('BIT_DEPTH', 16),
    inputGainDb: envInt('INPUT_GAIN_DB', 20), // Software gain applied to mic input (dB)
    // sox recording format args for HFP mono narrowband
    soxArgs: ['-d', '-t', 'wav', '-r', '16000', '-c', '1', '-b', '16', '-e', 'signed-integer', '-'],
  }),

  // ── Bluetooth ──
  bluetooth: Object.freeze({
    deviceName: env('BT_DEVICE_NAME', 'X8 Pro'),
    reconnectIntervalMs: envInt('BT_RECONNECT_INTERVAL_MS', 60000),
  }),

  // ── Wake Word ──
  wakeWord: Object.freeze({
    keyword: env('WAKE_WORD', 'razor'),
    porcupineAccessKey: env('PORCUPINE_ACCESS_KEY', ''),
    // If Porcupine key is present, use it; otherwise fall back to VAD+transcript
    get usePorcupine() {
      return this.porcupineAccessKey.length > 0;
    },
  }),

  // ── VAD ──
  vad: Object.freeze({
    energyThreshold: envFloat('VAD_ENERGY_THRESHOLD', 0.004),
    silenceDurationMs: envInt('VAD_SILENCE_DURATION_MS', 600),
    speechMinMs: envInt('VAD_SPEECH_MIN_MS', 150),
  }),

  // ── STT (Deepgram – used for VAD fallback transcript wake-word check) ──
  stt: Object.freeze({
    deepgramApiKey: env('DEEPGRAM_API_KEY', ''),
    endpointingMs: envInt('STT_ENDPOINTING_MS', 500), // Silence before Deepgram finalizes (was 3000)
  }),

  // ── TTS ──
  tts: Object.freeze({
    provider: env('TTS_PROVIDER', 'telnyx'),
    playbackMuteBufferMs: envInt('PLAYBACK_MUTE_BUFFER_MS', 200),
    maxCharsForSpeed: envInt('TTS_MAX_CHARS', 2000), // Raised: formatters self-limit; Telnyx handles 500-1000 chars fine

    telnyx: Object.freeze({
      apiKey: env('TELNYX_API_KEY', ''),
      // ── Voice recommendation (Natural tier: 24kHz/160kbps vs Kokoro 22kHz/32kbps) ──
      // Best male Natural voices (ranked by latency + clarity):
      //   1. Telnyx.Natural.boulder  – 750ms, 24kHz/160kbps, clear
      //   2. Telnyx.Natural.armon    – 757ms, 24kHz/160kbps, clear
      //   3. Telnyx.Natural.thunder  – 771ms, 24kHz/160kbps, deep
      //   4. Telnyx.Natural.blaze    – 793ms, 24kHz/160kbps, warm
      // Kokoro voices (22kHz/32kbps — lower quality, slightly faster):
      //   Telnyx.KokoroTTS.am_adam, am_michael, am_eric, am_onyx
      voice: env('TELNYX_VOICE', 'Telnyx.Natural.armon'),
      endpoint: 'https://api.telnyx.com/v2/text-to-speech/speech',
    }),

    elevenlabs: Object.freeze({
      apiKey: env('ELEVENLABS_API_KEY', ''),
      // Best natural male voices on ElevenLabs (ranked):
      //   1. "Adam"  (pNInz6obpgDQGcFmaJgB)  – deep, warm, broadcast quality
      //   2. "Josh"  (TxGEqnHWrfWFTfGW9XjX)  – conversational, friendly
      //   3. "Sam"   (yoZ06aMxZJJ28mfd3POQ)  – calm, articulate
      voiceId: env('ELEVENLABS_VOICE_ID', 'pNInz6obpgDQGcFmaJgB'),
      model: 'eleven_turbo_v2_5',
      endpoint: 'https://api.elevenlabs.io/v1/text-to-speech',
    }),

    macos: Object.freeze({
      voice: env('MACOS_TTS_VOICE', 'Samantha'),
      // Words-per-minute mapping for dynamic pacing via `say -r`
      wpmUrgent: envInt('MACOS_TTS_WPM_URGENT', 220),
      wpmNormal: envInt('MACOS_TTS_WPM_NORMAL', 200),
      wpmCalm:   envInt('MACOS_TTS_WPM_CALM', 165),
    }),
  }),

  // ── Dynamic Pacing ──
  pacing: Object.freeze({
    urgent: Object.freeze({ rate: 1.05, pitch: '+2st', pauseMs: 200 }),
    normal: Object.freeze({ rate: 1.00, pitch: '+0st', pauseMs: 400 }),
    calm:   Object.freeze({ rate: 0.90, pitch: '-1st', pauseMs: 600 }),
  }),

  // ── Logging ──
  logLevel: env('LOG_LEVEL', 'info'),
});

export default config;
