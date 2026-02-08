#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════
 *   RAZOR VOICE SERVICE v2.0
 * 
 *   Always-listening. No commands. Just talk.
 *   Everything goes through OpenClaw — AI understands intent.
 * 
 *   Ortizan X8 Pro Mic → [Wake Word] → STT → OpenClaw → TTS → Speaker
 * ═══════════════════════════════════════════════════════════
 */
import { readFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { log, logError } from './lib/log.js';
import { BluetoothManager } from './audio/bluetooth.js';
import { WakeWordListener } from './audio/wakeword.js';
import { checkAudioInput, startRecording, stopRecording, isRecording, blockRecording, unblockRecording } from './audio/capture.js';
import { playAudio, stopPlayback, isSpeaking, setBlockCallbacks } from './audio/playback.js';
import { setupTerminalPTT, startHTTPServer } from './audio/hotkey.js';
import { transcribe } from './api/stt.js';
import { synthesize, cleanForSpeech } from './api/tts.js';
import { GatewayClient } from './api/openclaw.js';
import { StateMachine } from './state/machine.js';
import { ProactiveEngine } from './state/proactive.js';
import { detectMood, getMoodPrefix, getMoodTTSParams } from './src/utils/mood-detector.js';
import { naturalize } from './src/utils/naturalizer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP_DIR = join(tmpdir(), 'razor-voice');

// ─── Load Config ──────────────────────────────────────────────────────────────

const config = JSON.parse(await readFile(join(__dirname, 'config.json'), 'utf8'));
const TELNYX_API_KEY = process.env.TELNYX_API_KEY;

if (!TELNYX_API_KEY) {
  console.error('\n  ❌  TELNYX_API_KEY not set.\n');
  process.exit(1);
}

// ─── Initialize Components ────────────────────────────────────────────────────

const STATE_FILE = join(__dirname, 'state', 'current.json');
const bt = new BluetoothManager(config);
const sm = new StateMachine(STATE_FILE);
const gateway = new GatewayClient(config);
const proactive = new ProactiveEngine(sm, config);
const wakeword = new WakeWordListener(config);

let processing = false;
let micAvailable = false;
let wakewordActive = false;
let wasInterrupted = false;
let currentMood = 'neutral';

// ─── Core Voice Functions ─────────────────────────────────────────────────────

async function speak(text, ttsParams = {}) {
  if (!text) return;
  try {
    const clean = cleanForSpeech(text);
    if (!clean) return;
    log('🔊', `Speaking ${clean.length} chars`);
    const audio = await synthesize(text, config, TELNYX_API_KEY, ttsParams);
    if (audio) await playAudio(audio);
  } catch (err) {
    logError('Speak failed', err);
  }
}

/**
 * Format response for speech with mood-appropriate prefix and natural phrasing.
 */
function formatResponseForSpeech(response, mood = 'neutral') {
  const prefix = getMoodPrefix(mood);
  response = prefix + response;
  response = naturalize(response);
  return response;
}

/**
 * The one pipeline. Every voice input goes here.
 * No keyword matching. No regex. No command parsing.
 * Send it all to the AI — it understands intent from context.
 * 
 * State transitions are signaled by the AI via <<STATE:XXX>> tags
 * in the response, which we parse out and apply silently.
 */
async function processAudio(wavPath) {
  if (processing) return;
  if (!wavPath || !existsSync(wavPath)) return;
  processing = true;

  try {
    // 1. Transcribe
    const transcript = await transcribe(wavPath, config, TELNYX_API_KEY);
    if (!transcript) { processing = false; return; }

    // 1.5. Detect mood from user input
    const { mood, confidence } = detectMood(transcript);
    currentMood = mood;

    // 2. Build the message with voice context
    const voiceMessage = buildVoiceMessage(transcript);

    // 3. Send to Razor via gateway — AI handles EVERYTHING
    log('🤖', 'Thinking...');
    const response = await gateway.sendChat(voiceMessage);

    if (!response || response === 'NO_REPLY' || response === 'HEARTBEAT_OK') {
      processing = false;
      return;
    }

    // 4. Parse state transitions from response (if any)
    const { text: cleanResponse, stateChange } = parseStateDirective(response);

    // 5. Apply state change if the AI signaled one
    if (stateChange) {
      log('🔄', `AI triggered state: ${stateChange}`);
      await sm.transition(stateChange);
    }

    // 6. Apply mood formatting + naturalization, then speak
    if (cleanResponse) {
      const spokenResponse = formatResponseForSpeech(cleanResponse, currentMood);
      const ttsParams = getMoodTTSParams(currentMood);
      log('💬', `[${currentMood}] ${spokenResponse.substring(0, 100)}${spokenResponse.length > 100 ? '...' : ''}`);
      await speak(spokenResponse, ttsParams);
    }

    sm.stats.lastActivity = Date.now();

  } catch (err) {
    logError('Pipeline error', err);
    try { await speak(`Something went wrong. ${err.message}`); } catch {}
  } finally {
    processing = false;
  }
}

/**
 * Build voice message with context for the AI.
 * Includes current state so the AI can reason about behavior.
 */
function buildVoiceMessage(transcript) {
  const state = sm.current;
  const stats = sm.stats;
  const hour = new Date().getHours();
  const timeOfDay = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
  const interrupted = wasInterrupted;
  wasInterrupted = false;

  return (
    (interrupted
      ? '[Al INTERRUPTED your response — he cut you off mid-sentence. Do NOT repeat what you were saying. Listen to what he says now and respond to THAT.]\n'
      : '') +
    `[VOICE INPUT | State: ${state} | Time: ${timeOfDay} | ` +
    `Calls today: ${stats.callsToday} | Emails: ${stats.emailsToday} | ` +
    `Meetings: ${stats.meetingsBooked}]\n` +
    `Al said: "${transcript}"\n\n` +
    `Respond naturally as spoken conversation through a speaker. ` +
    `Be concise — this is voice, not text. ` +
    `Say "gonna" not "going to", "opp" not "opportunity".\n\n` +
    `If Al's words imply a state change, append ONE of these tags at the very end of your response ` +
    `(it will be stripped before speaking):\n` +
    `<<STATE:ACTIVE>> — Al arrived, is back, wants engagement\n` +
    `<<STATE:ON_CALL>> — Al is about to make or is on a call\n` +
    `<<STATE:DEBRIEF>> — Al just finished a call and is debriefing\n` +
    `<<STATE:MEETING>> — Al is going into a meeting\n` +
    `<<STATE:BREAK>> — Al is stepping away\n` +
    `<<STATE:FOCUS>> — Al wants no interruptions\n` +
    `<<STATE:CLOSING>> — Al is done for the day\n` +
    `Only include a state tag if the intent is clear. Most messages won't need one.`
  );
}

/**
 * Parse <<STATE:XXX>> directive from AI response.
 * Returns clean text and optional state change.
 */
function parseStateDirective(response) {
  const stateMatch = response.match(/<<STATE:(\w+)>>/);
  if (stateMatch) {
    const stateChange = stateMatch[1];
    const text = response.replace(/\s*<<STATE:\w+>>\s*/g, '').trim();
    return { text, stateChange };
  }
  return { text: response, stateChange: null };
}

/**
 * Process voice from PTT (fallback when no wake word).
 */
async function processVoicePTT() {
  if (processing) return;
  const wavPath = await stopRecording();
  if (!wavPath || !existsSync(wavPath)) return;
  await processAudio(wavPath);
}

// ─── PTT Toggle (fallback) ───────────────────────────────────────────────────

async function handlePTTToggle() {
  if (isSpeaking()) {
    wasInterrupted = true;
    stopPlayback();
    return { action: 'interrupted' };
  }
  if (isRecording()) {
    processVoicePTT();
    return { action: 'stop', processing: true };
  }
  if (processing) return { action: 'busy', processing: true };
  if (!micAvailable) return { action: 'error', reason: 'no microphone' };

  wakeword.block();
  await startRecording(config);
  return { action: 'start', recording: true };
}

// ─── Feedback Loop Prevention ─────────────────────────────────────────────────

setBlockCallbacks(
  () => { blockRecording(); wakeword.block(); },
  () => { unblockRecording(); wakeword.unblock(); }
);

// ─── Wire Components ──────────────────────────────────────────────────────────

proactive.speak = speak;
proactive.gateway = gateway;
gateway.onProactive = (text) => proactive.handleGatewayProactive(text);

wakeword.onWake = () => log('🎯', 'Wake word! Listening...');
wakeword.onUtterance = (wavPath) => {
  log('📝', 'Utterance captured');
  processAudio(wavPath);
};
wakeword.onInterrupt = () => {
  log('🛑', 'Barge-in! Killing playback, listening...');
  wasInterrupted = true;
  stopPlayback();
};

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function boot() {
  await mkdir(TMP_DIR, { recursive: true });

  const wakePhrase = config.wakeword?.customModelPath ? 'Razor' :
    (config.wakeword?.builtinKeyword || 'JARVIS');

  console.log('');
  console.log('  ═══════════════════════════════════════════════════');
  console.log('  🔪  RAZOR VOICE SERVICE v2.0');
  console.log('  ═══════════════════════════════════════════════════');
  console.log(`  Mode:      Always-listening (wake word: "${wakePhrase}")`);
  console.log(`  Device:    ${config.bluetooth.deviceName} (Bluetooth)`);
  console.log(`  STT:       ${config.telnyx.sttModel}`);
  console.log(`  TTS:       ${config.telnyx.ttsVoice}`);
  console.log(`  Gateway:   ws://${config.gateway.host}:${config.gateway.port}`);
  console.log('');

  // ── Step 1: Bluetooth ──
  log('🔵', 'Step 1: Bluetooth...');
  const btResult = await bt.initialize();
  log(btResult.ok ? '✅' : '⚠️',
    btResult.ok ? `${config.bluetooth.deviceName} ✓` : `${config.bluetooth.deviceName}: ${btResult.speaker ? 'speaker only' : 'not available'}`);

  // ── Step 2: Audio Input ──
  log('🔍', 'Step 2: Mic...');
  const audioCheck = await checkAudioInput();
  micAvailable = audioCheck.ok;
  log(micAvailable ? '✅' : '⚠️', micAvailable ? 'Mic working' : `Mic: ${audioCheck.error}`);

  // ── Step 3: Wake Word + Audio Monitor ──
  log('🎯', 'Step 3: Wake word + audio monitor...');
  if (micAvailable) {
    const porcupineOk = await wakeword.init();
    if (porcupineOk) {
      wakewordActive = true;
      log('✅', `Always-listening: say "${wakePhrase}"`);
    } else {
      log('⚠️', 'Wake word off — PTT fallback');
    }
    // Always start audio stream — enables voice interruption during TTS playback
    wakeword.start();
    log('🛑', 'Voice interruption detection enabled');
  }

  // ── Step 4: State ──
  await sm.load();
  log('📍', `State: ${sm.current}`);

  // ── Step 5: Gateway ──
  log('🔌', 'Step 5: Gateway...');
  try { await gateway.connect(); } catch (err) { log('⚠️', `Gateway: ${err.message}`); }

  // ── Step 6: HTTP + Proactive + BT Monitor ──
  startHTTPServer(config.http.port, config.http.bind, {
    onPTT: handlePTTToggle,
    onPTTStart: () => startRecording(config),
    onPTTStop: () => processVoicePTT(),
    onSpeak: (text) => speak(text),
    onStopPlayback: () => stopPlayback(),
    onStateChange: async (state) => {
      await sm.transition(state.toUpperCase());
      return { ok: true, state: sm.current };
    },
    onHealth: () => ({
      ok: true, state: sm.current, bluetooth: bt.connected,
      mic: micAvailable, wakeword: wakewordActive, gateway: gateway.isConnected,
      recording: isRecording(), listening: wakeword.isListening,
      processing, speaking: isSpeaking(),
    }),
    onStatus: () => ({
      ...sm.getStatus(), bluetooth: bt.getStatus(),
      mic: micAvailable, wakeword: wakewordActive, wakePhrase,
      gateway: gateway.isConnected, recording: isRecording(),
      listening: wakeword.isListening, processing, speaking: isSpeaking(),
      ttsVoice: config.telnyx.ttsVoice, sttModel: config.telnyx.sttModel,
    }),
  });

  proactive.start();
  bt.startMonitoring();

  setupTerminalPTT({
    onPTT: () => handlePTTToggle(),
    onStop: () => stopPlayback(),
    onQuit: () => shutdown(),
  });

  // ── Ready ──
  console.log('');
  console.log(`  Just talk. ${wakewordActive ? `Say "${wakePhrase}" first.` : 'Use ptt command.'}`);
  console.log('  No commands needed. I understand context.');
  console.log('');

  if (sm.current === 'BOOT') await sm.transition('WAITING');

  log('🎯', [
    `State: ${sm.current}`,
    bt.connected ? 'BT ✓' : 'BT ✗',
    micAvailable ? 'Mic ✓' : 'Mic ✗',
    wakewordActive ? `"${wakePhrase}" ✓` : 'PTT mode',
    gateway.isConnected ? 'GW ✓' : 'GW ✗',
  ].join(' | '));
}

function shutdown() {
  log('👋', 'Shutting down...');
  wakeword.stop(); bt.stopMonitoring();
  gateway.disconnect(); proactive.stop();
  sm.save().then(() => process.exit(0));
}

boot().catch(err => { console.error('Fatal:', err); process.exit(1); });
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
