// src/pipeline/voice-pipeline.js – Main Voice Pipeline Orchestrator
//
// Uses the shared state machine from src/state/stateMachine.js.
// 10 states: IDLE, LISTENING, PROCESSING, SPEAKING, INTERRUPTED,
//            BRIEFING, RESEARCHING, COACHING, LEARNING, ERROR
//
// Voice pipeline flow:
//   IDLE → LISTENING → PROCESSING → SPEAKING → LISTENING
//                ↑                       │
//                └── INTERRUPTED ────────┘
//
// Flow:
//   1. IDLE/LISTENING: Mic is live, VAD monitors, audio ring buffer active (3s)
//   2. Speech detected → check for wake word
//      a. Porcupine mode: wake detected in real-time → open STT + replay buffer
//      b. Transcript mode: VAD speech ends → batch STT → check for "razor"
//   3. Wake word found → transition to PROCESSING
//      a. Ring buffer replayed into STT — captures one-breath commands
//      b. "Razor what's on my calendar" works without pausing
//      c. Wake word stripped from transcript, command extracted
//   4. Command received → emit 'command' for external handler
//   5. External handler calls pipeline.speak(text, {pace}) → TTS → playback
//   6. During playback: mic muted, interruption handler active
//   7. If interrupted: transition to INTERRUPTED → kill playback →
//      next tick → transition to LISTENING

import EventEmitter from 'eventemitter3';
import AudioCapture from '../audio/capture.js';
import AudioPlayback from '../audio/playback.js';
import BluetoothMonitor from '../audio/bluetooth.js';
import VadEngine from '../vad/vad-engine.js';
import { createWakeWordDetector } from '../wake-word/index.js';
import DeepgramStream from '../stt/deepgram-stream.js';
import TtsEngine from '../tts/tts-engine.js';
import InterruptionHandler from './interruption-handler.js';
import { attention } from './attention.js';
import { followUpMode } from './follow-up-mode.js';
import { conversationContext } from '../context/conversation-context.js';
import { ackPlayer } from '../audio/ack-player.js';
import { getStateMachine, States } from '../state/stateMachine.js';
import { userState } from '../state/user-state.js';
import config from '../config.js';
import makeLogger from '../utils/logger.js';

const log = makeLogger('Pipeline');

class VoicePipeline extends EventEmitter {
  constructor() {
    super();

    // ── Shared state machine (singleton) ──
    this.sm = getStateMachine({ verbose: true });

    // ── Components ──
    this.capture = new AudioCapture();
    this.playback = new AudioPlayback();
    this.bluetooth = new BluetoothMonitor();
    this.vad = new VadEngine();
    this.tts = new TtsEngine();
    this.interruptHandler = new InterruptionHandler(this.playback);

    // Wake word detector (set during init)
    this.wakeDetector = null;
    this.wakeType = null; // 'porcupine' | 'transcript'

    // Streaming STT (opened on demand after wake word)
    this.sttStream = null;

    // Ack playback process (short acknowledgment)
    this._ackProcess = null;
    this._ackDone = Promise.resolve(); // resolves when ack finishes + mic is clean

    // ── Timers ──
    this.commandTimeout = null;
    this.sentenceTimer = null;
    this.commandTimeoutMs = 8000; // safety cap — endpointing handles fast finalization

    // ── Attention: 5-minute awake window after any interaction ──
    // Managed by attention singleton (src/pipeline/attention.js)
    // Follow-up mode delegates to attention + adds 500ms grace period

    // ── Rolling audio buffer for one-breath commands ──
    // Keeps last 3s of PCM. When wake word fires, we replay this into STT
    // so "Razor what's on my calendar" (said in one breath) is fully captured.
    this._audioRing = [];
    this._audioRingMaxMs = 3000;
    this._wakeTimestamp = 0;

    // ── Bridge state machine transitions to pipeline events ──
    // so index.js and other modules can subscribe via either interface
    this.sm.on('transition', (record) => {
      log.info(`State: ${record.from} → ${record.to} [${record.trigger}]`);
      this.emit('state', record.to, record.from);
    });
  }

  // ── Initialize all components ──
  async init() {
    log.info('═══════════════════════════════════════════');
    log.info('  Razor Voice Agent – Initializing');
    log.info('═══════════════════════════════════════════');

    // 1. Bluetooth
    log.info('→ Setting up Bluetooth...');
    const btConnected = await this.bluetooth.start();
    if (!btConnected) {
      log.warn('Bluetooth not connected — mic may not work. Continuing anyway...');
    }

    // 2. Wake word detector
    log.info('→ Setting up wake word detection...');
    const { type, detector } = await createWakeWordDetector();
    this.wakeType = type;
    this.wakeDetector = detector;

    // 3. Preload acknowledgment audio (TTS-generated acks in assets/acks/)
    log.info('→ Preloading ack audio...');
    await ackPlayer.preload();

    // 4. Fallback: generate macOS say acks if no TTS acks available
    if (!ackPlayer.ready) {
      log.info('→ No TTS acks found — generating fallback ack tones...');
      await this.tts.warmup();
    }

    // 5. Wire up events
    this.wireEvents();

    // 6. Tighter state machine timeouts for faster recovery
    //    PROCESSING: 30s watchdog (default 90s) — catches hung brain calls
    //    ERROR: 5s recovery (default 30s) — faster return to LISTENING
    this.sm.setTimeoutOverride(States.PROCESSING, 30_000);
    this.sm.setTimeoutOverride(States.ERROR, 5_000);

    log.info('═══════════════════════════════════════════');
    log.info(`  Wake word strategy: ${this.wakeType}`);
    log.info(`  TTS provider: ${this.tts.provider}`);
    log.info(`  Bluetooth: ${btConnected ? 'connected ✓' : 'disconnected ✗'}`);
    log.info('═══════════════════════════════════════════');

    return this;
  }

  // ── Wire all event handlers ──
  wireEvents() {
    // ── Audio Capture → VAD + Interruption ──
    this.capture.on('data', (pcm) => { 
      // Always send to interruption handler (bypasses mic mute)
      this.interruptHandler.checkChunk(pcm);

      // Always buffer audio for pre-wake replay (even during ack)
      this._pushAudioRing(pcm);

      // VAD only processes when not muted (normal pipeline flow)
      if (!this.capture.isMuted) {
        // Porcupine gets raw PCM in real-time
        if (this.wakeType === 'porcupine' && this.sm.getState().state === States.LISTENING) {
          this.wakeDetector.process(pcm);
        }

        // VAD always processes (for transcript fallback or command capture)
        this.vad.process(pcm);

        // If we have an active STT stream, send data
        if (this.sttStream?.connected) {
          this.sttStream.send(pcm);
        }
      }
    });

    // ── VAD Events ──
    this.vad.on('speech:start', () => {
      // When attention is awake (past grace period), speech starts command
      // capture without wake word. isReady() returns false during the first
      // 500ms after playback to avoid false triggers from speaker bleed.
      if (followUpMode.isReady() && this.sm.getState().state === States.LISTENING) {
        log.info('Attention active — capturing without wake word');
        this._wakeTimestamp = Date.now();
        followUpMode.consume();
        attention.activity();
        this.sm.transition(States.PROCESSING, 'attention_follow_up');
        this.captureCommand();
      }
    });

    this.vad.on('speech:end', (segment) => {
      if (this.sm.getState().state === States.LISTENING && this.wakeType === 'transcript') {
        // Transcript fallback: check VAD segment for wake word
        this.wakeDetector.checkAudio(segment);
      }
    });

    // ── Wake Word Events ──
    if (this.wakeType === 'porcupine') {
      this.wakeDetector.on('wake', () => {
        this.onWakeDetected({ command: '' });
      });
    } else {
      // Transcript detector
      this.wakeDetector.on('wake', (data) => {
        this.onWakeDetected(data);
      });
    }

    // ── Playback Events (feedback loop prevention + BT poll pause) ──
    this.playback.on('playback:start', () => {
      this._pauseMic();
      this.bluetooth.pausePolling();
      this.interruptHandler.startMonitoring();
    });

    this.playback.on('playback:end', () => {
      this.interruptHandler.stopMonitoring();
      this.bluetooth.resumePolling();
      this._resumeMic();
      this.sm.transition(States.LISTENING, 'tts_finished');
      // Enter follow-up mode — user can speak without wake word for 5s
      followUpMode.enter();
    });

    this.playback.on('playback:interrupt', () => {
      this.interruptHandler.stopMonitoring();
      this.bluetooth.resumePolling();
      this._resumeMic({ immediate: true });
      if (this.sm.getState().state !== States.INTERRUPTED) {
        this.sm.transition(States.LISTENING, 'playback_killed');
      }
    });

    this.playback.on('playback:error', (err) => {
      log.error('Playback error:', err?.message || err);
      this.interruptHandler.stopMonitoring();
      this.bluetooth.resumePolling();
      this._resumeMic();
      if (this.sm.getState().state === States.SPEAKING) {
        this.sm.transition(States.LISTENING, 'playback_error');
      }
    });

    // ── Interruption Handler (Barge-In) ──
    // When the user speaks during Razor's response:
    //   1. Stop playback immediately
    //   2. Transition SPEAKING → INTERRUPTED → LISTENING
    //   3. Enter follow-up mode so the user's speech is captured
    //      without needing to say "Razor" again
    this.interruptHandler.on('interrupt', async () => {
      log.warn('User barge-in → INTERRUPTED → killing playback');

      // 1. Enter INTERRUPTED state first
      this.sm.transition(States.INTERRUPTED, 'user_barge_in');

      // 2. Kill playback
      await this.playback.interrupt();

      // 3. Next tick: transition to LISTENING + wake attention
      //    The user was already speaking (that's what triggered the interrupt),
      //    so they shouldn't need to say "Razor" again.
      process.nextTick(() => {
        this.sm.transition(States.LISTENING, 're_listen');
        attention.wake('barge_in');
        followUpMode.enter();
      });
    });

    // ── Bluetooth Events ──
    this.bluetooth.on('disconnected', () => {
      log.warn('Bluetooth disconnected — pausing pipeline');
      this.capture.stop();
      this.sm.transition(States.IDLE, 'bt_disconnected');
    });

    this.bluetooth.on('reconnected', () => {
      log.info('Bluetooth reconnected — resuming pipeline');
      if (!this.capture.isRunning) {
        this.capture.start();
      }
      this.sm.transition(States.LISTENING, 'bt_reconnected');
    });
  }

  // ── Start the pipeline ──
  async start() {
    log.info('Starting voice pipeline...');
    this.capture.start();
    this.sm.transition(States.LISTENING, 'pipeline_start');
    log.info('🎙  Razor is listening. Say "Razor" to activate.');
  }

  // ── Stop the pipeline ──
  async stop() {
    log.info('Stopping voice pipeline...');

    attention.destroy();
    followUpMode.exit();
    if (this.commandTimeout) clearTimeout(this.commandTimeout);
    if (this.sttStream) await this.sttStream.close();

    this.capture.stop();
    this.bluetooth.stop();
    this.vad.reset();

    if (this.wakeType === 'porcupine') {
      this.wakeDetector.destroy();
    }

    if (this.playback.isPlaying) {
      await this.playback.interrupt();
    }

    this.sm.transition(States.IDLE, 'pipeline_stop');
    log.info('Voice pipeline stopped');
  }

  // ── Check if a command is a complete sentence ──
  // If it ends with punctuation (.!?) → complete immediately, any length.
  // If no punctuation → need 4+ words (STT sometimes omits punctuation).
  _isCommandComplete(text) {
    if (!text) return false;
    const trimmed = text.trim();
    const words = trimmed.split(/\s+/).filter(Boolean);
    if (words.length === 0) return false;

    // Ends with punctuation → always complete ("Hello." "Look up Marcus.")
    if (/[.?!]$/.test(trimmed)) return true;

    // No punctuation but enough words → complete (3+ words is a real command)
    if (words.length >= 3) return true;

    return false;
  }

  // ── Mic control helpers (single source of truth for mute/unmute + VAD) ──

  _pauseMic() {
    this.capture.mute();
    this.vad.reset();
  }

  _resumeMic({ immediate = false } = {}) {
    this.vad.reset();
    if (immediate) {
      this.capture.unmuteNow();
    } else {
      this.capture.unmute(); // 200ms buffer delay from config
    }
  }

  // ── Audio ring buffer: keeps last 3s of PCM for one-breath command replay ──

  _pushAudioRing(pcm) {
    const now = Date.now();
    this._audioRing.push({ pcm, ts: now });
    const cutoff = now - this._audioRingMaxMs;
    while (this._audioRing.length > 0 && this._audioRing[0].ts < cutoff) {
      this._audioRing.shift();
    }
  }

  _drainAudioRingSince(sinceMs) {
    return this._audioRing
      .filter(e => e.ts >= sinceMs)
      .map(e => e.pcm);
  }

  // ── Strip wake word from beginning of STT transcript ──
  // Ring buffer replay includes "Razor" audio, so Deepgram transcribes it.
  // We strip it to get just the command.
  _stripWakeWord(text) {
    return text.replace(/^(hey\s+)?(razor|razer|raze her|raise or|raiser)[.,!?\s]*/i, '').trim();
  }

  // ── Handle wake word detection ──
  async onWakeDetected({ command, transcript }) {
    if (this.sm.getState().state !== States.LISTENING) {
      log.debug('Wake word detected but not in LISTENING state — ignoring');
      return;
    }

    log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log.info('  🎯 WAKE WORD DETECTED');
    log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    this._wakeTimestamp = Date.now();
    attention.wake('wake_word');
    followUpMode.exit();

    // Ack disabled — was causing double-voice overlap with TTS
    // this.playAck('quick');

    this.sm.transition(States.PROCESSING, 'wake_word');

    // If transcript mode captured text after "razor", check if it's complete
    if (command && command.length > 2) {
      if (this._isCommandComplete(command)) {
        log.info(`Complete command from wake transcript: "${command}"`);
        this.emit('command', {
          text: command,
          source: 'wake-transcript',
          fullTranscript: transcript,
        });
        return;
      }

      // Incomplete fragment — capture more speech with this as prefix
      log.info(`Partial command "${command}" — waiting for more speech...`);
      await this.captureCommand(command);
      return;
    }

    // No command yet (user said just "Razor" and paused) —
    // open streaming STT to capture the follow-up command.
    log.info('Waiting for command...');
    await this.captureCommand();
  }

  // ── Open streaming STT and wait for complete command ──
  // Opens STT IMMEDIATELY (no waiting for ack) and replays the audio ring
  // buffer so one-breath commands like "Razor what's on my calendar" are captured.
  async captureCommand(prefix = '') {
    this.sttStream = new DeepgramStream();

    const parts = prefix ? [prefix] : [];
    let done = false;
    // First transcript from buffer replay may include "Razor" — strip it
    let stripNextFinal = !prefix;

    const getFullCommand = () => parts.join(' ').trim();

    const finish = (source) => {
      if (done) return;
      done = true;
      const commandText = getFullCommand();
      log.info(`Command captured: "${commandText}"`);
      attention.activity();
      this.cleanupCommandCapture();
      this.emit('command', { text: commandText, source });
    };

    // After each final transcript with 2+ words but no sentence-ending punctuation,
    // wait 800ms for additional speech before emitting
    const resetSentenceTimer = () => {
      if (this.sentenceTimer) clearTimeout(this.sentenceTimer);
      const cmd = getFullCommand();
      const words = cmd.split(/\s+/).filter(Boolean).length;
      if (words >= 2) {
        this.sentenceTimer = setTimeout(() => {
          finish('streaming-stt-sentence-timeout');
        }, 800);
      }
    };

    this.sttStream.on('transcript:final', ({ text }) => {
      if (done) return;

      // Strip wake word from first transcript (buffer replay includes "Razor" audio)
      let cleaned = text;
      if (stripNextFinal) {
        cleaned = this._stripWakeWord(text);
        stripNextFinal = false;
      }
      if (cleaned) parts.push(cleaned);

      const cmd = getFullCommand();
      if (this._isCommandComplete(cmd)) {
        finish('streaming-stt');
        return;
      }

      resetSentenceTimer();
    });

    this.sttStream.on('transcript:partial', ({ text }) => {
      const cleaned = stripNextFinal ? this._stripWakeWord(text) : text;
      this.emit('command:partial', { text: prefix ? `${prefix} ${cleaned}` : cleaned });
    });

    this.sttStream.on('utterance:end', () => {
      if (done) return;
      const cmd = getFullCommand();
      const words = cmd.split(/\s+/).filter(Boolean).length;
      // Utterance end = Deepgram detected silence (500ms endpointing)
      if (words >= 2) {
        finish('streaming-stt-utterance-end');
      }
    });

    try {
      await this.sttStream.connect();
    } catch (err) {
      log.error('Failed to connect streaming STT:', err.message);
      if (prefix) {
        this.emit('command', { text: prefix, source: 'streaming-stt-fallback' });
      }
      this.sm.transition(States.LISTENING, 'stt_connect_failed');
      return;
    }

    // Replay buffered audio from just before wake detection.
    // This is the key to one-breath commands: the ring buffer captured
    // "what's on my calendar" even though STT wasn't open yet.
    const replayChunks = this._drainAudioRingSince(this._wakeTimestamp - 200);
    if (replayChunks.length > 0) {
      log.info(`Replaying ${replayChunks.length} buffered audio chunks into STT`);
      for (const chunk of replayChunks) {
        this.sttStream.send(chunk);
      }
    }
    this._audioRing = []; // Clear to prevent overlap with live data

    // Overall timeout: emit whatever we have or go back to listening
    this.commandTimeout = setTimeout(() => {
      if (!done) {
        const cmd = getFullCommand();
        if (cmd) {
          log.warn(`Command timeout — emitting partial: "${cmd}"`);
          finish('streaming-stt-timeout');
        } else {
          log.warn('Command timeout — no speech after wake word');
          this.cleanupCommandCapture();
          this.sm.transition(States.LISTENING, 'command_timeout');
          this.emit('command:timeout');
        }
      }
    }, this.commandTimeoutMs);
  }

  // ── Cleanup streaming STT ──
  cleanupCommandCapture() {
    if (this.commandTimeout) {
      clearTimeout(this.commandTimeout);
      this.commandTimeout = null;
    }
    if (this.sentenceTimer) {
      clearTimeout(this.sentenceTimer);
      this.sentenceTimer = null;
    }
    if (this.sttStream) {
      this.sttStream.close().catch(() => {});
      this.sttStream = null;
    }
  }

  // ── Play a short acknowledgment (does NOT mute mic) ──
  // Mic stays live so the audio ring buffer captures one-breath commands.
  // Uses AckPlayer (TTS-generated) with fallback to old warmup acks.
  playAck(context = 'quick') {
    // Prefer AckPlayer TTS-generated files, fall back to warmup acks
    const ackFile = ackPlayer.ready
      ? ackPlayer.getContextualFile(context)
      : this.tts.getRandomAckFile();
    if (!ackFile) return;

    if (this._ackProcess) {
      try { this._ackProcess.kill(); } catch { /* ignore */ }
    }

    // DON'T mute mic — we need continuous audio for one-breath commands.
    // Just reset VAD to prevent the tone from triggering speech detection.
    this.vad.reset();

    let settled = false;
    this._ackDone = new Promise((resolve) => {
      const settle = () => {
        if (settled) return;
        settled = true;
        this._ackProcess = null;
        resolve();
      };

      this._ackProcess = this.playback.playFile(ackFile);
      this._ackProcess.on('close', settle);
      this._ackProcess.on('error', settle);

      // Safety: if ack doesn't finish in 1.5s, force cleanup
      setTimeout(settle, 1500);
    });
  }

  // ── Speak text (called by external command handler) ──
  // Respects user availability state: if user is IN_CALL or DND and Razor
  // is initiating proactively, the speech is queued instead of spoken.
  // Direct responses to user commands always go through (user asked for it).
  async speak(text, { pace = 'normal', proactive = false } = {}) {
    if (!text) return;

    // If this is proactive speech (not a direct response), check user state
    if (proactive && !userState.canSpeak) {
      log.info(`Suppressed proactive speech (user state: ${userState.state}): "${text.slice(0, 50)}..."`);
      userState.submitAlert({
        priority: 'normal',
        message: text,
        source: 'proactive_speech',
      });
      return;
    }

    followUpMode.exit();

    // Kill any playing ack before starting real TTS
    if (this._ackProcess) {
      try { this._ackProcess.kill('SIGKILL'); } catch { /* ignore */ }
      this._ackProcess = null;
    }

    this.sm.transition(States.SPEAKING, 'tts_start');

    try {
      const result = await this.tts.synthesize(text, { pace });
      if (!result) {
        this.sm.transition(States.LISTENING, 'tts_empty');
        return;
      }

      await this.playback.play(result.buffer, {
        pace,
        format: result.format,
      });
      // playback:end or playback:interrupt will handle state transitions
    } catch (err) {
      log.error('Speak failed:', err.message);
      this._resumeMic();
      this.sm.transition(States.LISTENING, 'tts_error');
    }
  }

  // ── State accessor (delegates to state machine) ──
  // Called when TTS is skipped (empty response) - transitions pipeline back to listening
  returnToListening(trigger = 'skip_response') {
    if (this.sm.getState().state !== States.LISTENING) {
      this.sm.transition(States.LISTENING, trigger);
    }
  }

  getState() {
    return this.sm.getState().state;
  }
}

export { VoicePipeline, States };
export default VoicePipeline;
