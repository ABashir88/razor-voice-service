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
import { fillerPlayer } from '../audio/filler-player.js';
import { getStateMachine, States } from '../state/stateMachine.js';
import { userState } from '../state/user-state.js';
import { sttCorrections } from '../stt/correction-memory.js';
import { auditPersonality, computeExperienceScore, logTurnBlock } from '../utils/humanoid-metrics.js';
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
    this.commandTimeoutMs = 10000; // safety cap — endpointing handles fast finalization

    // ── Attention: 5-minute awake window after any interaction ──
    // Managed by attention singleton (src/pipeline/attention.js)
    // Follow-up mode delegates to attention + adds 500ms grace period

    // ── Rolling audio buffer for one-breath commands ──
    // Keeps last 3s of PCM. When wake word fires, we replay this into STT
    // so "Razor what's on my calendar" (said in one breath) is fully captured.
    this._audioRing = [];
    this._audioRingMaxMs = 3000;
    this._wakeTimestamp = 0;

    // ── Latency tracking for [Latency] / [Humanness] logs ──
    this._userStoppedAt = 0;
    this._ackPlayedAt = 0;

    // ── Humanoid telemetry — turn lifecycle ──
    this._turnNumber = 0;
    this._sessionXPScores = [];
    this._recentCommands = []; // last 5 commands with timestamps for repeat detection
    this._turn = null;         // current turn state object (set by _startTurn)
    this._rhythmData = { userSpeechMs: [], razorSpeechMs: [], turnsPerMinute: [], _firstTurnAt: 0 };
    // STT values captured during transcript:final (before _turn exists)
    this._lastSttConfidence = null;
    this._lastSttOriginal = null;
    this._lastSttCorrected = null;

    // ── Session stats for [Session] logs ──
    this._sessionStats = {
      turns: 0,
      wakeWords: 0,
      followUps: 0,
      silentResponses: 0,
      avgResponseMs: 0,
      totalResponseMs: 0,
      actionsTriggered: 0,
      actionsFailed: 0,
      fellbackToPattern: 0,
      frankensteinCount: 0,
      deadCodeAckCount: 0,
      patternHits: 0,
      cacheHits: 0,
      fillerPlayed: 0,
      fillerMissed: 0,
    };

    // ── Integration health tracking (Update 8) ──
    // Tracks per-integration success/fail/timing — logged on shutdown
    this._integrationHealth = {};  // { serviceName: { success, fail, totalMs, calls } }

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

    // 3. Load STT correction memory
    log.info('→ Loading STT corrections...');
    sttCorrections.load();

    // 4. Preload filler phrases (Telnyx armon voice — same as responses)
    log.info('→ Preloading filler phrases...');
    await fillerPlayer.preload();

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
        // Ack moved to AFTER final transcript (was interrupting user mid-speech)
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
      if (this._turn) this._turn.ttsEndMs = Date.now();
      this.interruptHandler.stopMonitoring();
      this.bluetooth.resumePolling();
      this._resumeMic();
      this.sm.transition(States.LISTENING, 'tts_finished');
      // Enter follow-up mode — user can speak without wake word for 5s
      followUpMode.enter();
      this._endTurn();
    });

    this.playback.on('playback:interrupt', () => {
      if (this._turn) { this._turn.ttsEndMs = Date.now(); this._turn.flags.push('interrupted'); }
      this.interruptHandler.stopMonitoring();
      this.bluetooth.resumePolling();
      this._resumeMic({ immediate: true });
      if (this.sm.getState().state !== States.INTERRUPTED) {
        this.sm.transition(States.LISTENING, 'playback_killed');
      }
      this._endTurn();
    });

    this.playback.on('playback:error', (err) => {
      if (this._turn) this._turn.flags.push('playback_error');
      log.error('Playback error:', err?.message || err);
      this.interruptHandler.stopMonitoring();
      this.bluetooth.resumePolling();
      this._resumeMic();
      if (this.sm.getState().state === States.SPEAKING) {
        this.sm.transition(States.LISTENING, 'playback_error');
      }
      this._endTurn();
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
    fillerPlayer.stop();
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

    // ── [Session] Summary on shutdown ──
    const s = this._sessionStats;
    if (s.turns > 0) {
      log.info('[Session] ═══════════════════════════════════════');
      log.info('[Session] SESSION SUMMARY');
      log.info(`[Session]   Turns: ${s.turns} (${s.wakeWords} wake + ${s.followUps} follow-up)`);
      log.info(`[Session]   Actions: ${s.actionsTriggered} triggered, ${s.actionsFailed} failed`);
      log.info(`[Session]   Fallbacks: ${s.fellbackToPattern} pattern rescues`);
      log.info(`[Session]   Silent: ${s.silentResponses} empty responses`);
      log.info(`[Session]   Avg response: ${Math.round(s.totalResponseMs / s.turns)}ms`);
      log.info('[Session] ═══════════════════════════════════════');
    }

    // ── [Session] Humanoid Grade Card ──
    if (this._sessionXPScores.length > 0) {
      const scores = this._sessionXPScores;
      const avg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
      const grade = avg >= 90 ? 'A' : avg >= 75 ? 'B' : avg >= 60 ? 'C' : avg >= 40 ? 'D' : 'F';
      const dist = { A: 0, B: 0, C: 0, D: 0, F: 0 };
      for (const s of scores) {
        if (s >= 90) dist.A++;
        else if (s >= 75) dist.B++;
        else if (s >= 60) dist.C++;
        else if (s >= 40) dist.D++;
        else dist.F++;
      }
      const r = this._rhythmData;
      const avgUser = r.userSpeechMs.length > 0
        ? Math.round(r.userSpeechMs.reduce((a, b) => a + b, 0) / r.userSpeechMs.length)
        : 0;
      const avgRazor = r.razorSpeechMs.length > 0
        ? Math.round(r.razorSpeechMs.reduce((a, b) => a + b, 0) / r.razorSpeechMs.length)
        : 0;
      log.info('[Session] ── HUMANOID GRADE CARD ──');
      log.info(`[Session]   Overall: ${grade} (${avg}/100 avg over ${scores.length} turns)`);
      log.info(`[Session]   Distribution: A=${dist.A} B=${dist.B} C=${dist.C} D=${dist.D} F=${dist.F}`);
      log.info(`[Session]   Rhythm: user avg ${avgUser}ms, razor avg ${avgRazor}ms`);
      log.info('[Session] ─────────────────────────');

      // ── [Session] WEEK 1 SCORECARD ──
      const s2 = this._sessionStats;
      const totalTurns = scores.length;
      const singleVoice = s2.frankensteinCount === 0;
      const noSilent = s2.silentResponses === 0;
      const avgWait = totalTurns > 0 ? Math.round(s2.totalResponseMs / totalTurns) : 0;
      const avgWaitOk = avgWait < 2000;
      const fillerTotal = s2.fillerPlayed + s2.fillerMissed;
      const fillerCoverage = fillerTotal > 0 ? Math.round((s2.fillerPlayed / fillerTotal) * 100) : 100;
      const fillerOk = fillerCoverage >= 90;
      const personalityAvg = avg; // reuse from grade card
      const personalityOk = personalityAvg >= 70;
      const talkRatio = r.razorSpeechMs.length > 0 && avgRazor > 0 ? (avgUser / avgRazor) : 0;
      const talkRatioOk = talkRatio > 0 && talkRatio < 2.0;
      const noRetries = s2.actionsFailed === 0;

      const checks = [singleVoice, noSilent, avgWaitOk, fillerOk, personalityOk, talkRatioOk, noRetries];
      const passedCount = checks.filter(Boolean).length;
      const verdict = passedCount >= 6 ? 'PASS' : passedCount >= 4 ? 'MARGINAL' : 'FAIL';

      log.info('[Session] ── WEEK 1 SCORECARD ──');
      log.info(`[Session]   ${singleVoice ? '✓' : '✗'} Single voice (frankenstein: ${s2.frankensteinCount})`);
      log.info(`[Session]   ${noSilent ? '✓' : '✗'} No silent turns (silent: ${s2.silentResponses})`);
      log.info(`[Session]   ${avgWaitOk ? '✓' : '✗'} Avg wait <2s (actual: ${avgWait}ms)`);
      log.info(`[Session]   ${fillerOk ? '✓' : '✗'} Filler coverage ≥90% (actual: ${fillerCoverage}%)`);
      log.info(`[Session]   ${personalityOk ? '✓' : '✗'} Personality avg ≥70 (actual: ${personalityAvg})`);
      log.info(`[Session]   ${talkRatioOk ? '✓' : '✗'} Talk ratio <2.0x (actual: ${talkRatio.toFixed(2)}x)`);
      log.info(`[Session]   ${noRetries ? '✓' : '✗'} No retries (failures: ${s2.actionsFailed})`);
      log.info(`[Session]   Cache hits: ${s2.cacheHits} | Pattern hits: ${s2.patternHits}`);
      log.info(`[Session]   WEEK 1 VERDICT: ${verdict} (${passedCount}/7)`);
      log.info('[Session] ─────────────────────────');
    }

    // ── [Session] Integration Health Summary ──
    const healthEntries = Object.entries(this._integrationHealth);
    if (healthEntries.length > 0) {
      log.info('[Session] ── INTEGRATION HEALTH ──');
      for (const [svc, h] of healthEntries) {
        const avgMs = h.calls > 0 ? Math.round(h.totalMs / h.calls) : 0;
        const rate = h.calls > 0 ? Math.round((h.success / h.calls) * 100) : 0;
        log.info(`[Session]   ${svc}: ${h.success}✓ ${h.fail}✗ (${rate}% success, avg ${avgMs}ms)`);
      }
      log.info('[Session] ─────────────────────────');
    }

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
    return text.replace(/^(hey\s+)?(razor|razer|razar|fraser|frazer|caesar|roger|laser|raiser|riser|rizar|raze her|raise or)[.,!?\s]*/i, '').trim();
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

    // Ack moved to AFTER final transcript (was interrupting user mid-speech)

    this.sm.transition(States.PROCESSING, 'wake_word');

    // If transcript mode captured text after "razor", check if it's complete
    if (command && command.length > 2) {
      if (this._isCommandComplete(command)) {
        log.info(`Complete command from wake transcript: "${command}"`);
        this._userStoppedAt = Date.now();
        log.info(`[Latency] User stopped speaking at ${this._userStoppedAt}`);
        this._startTurn(command);
        // Play filler phrase — natural thinking sound while brain processes
        this._playFiller(command);
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
      this._userStoppedAt = Date.now();
      log.info(`Command captured: "${commandText}"`);
      log.info(`[Latency] User stopped speaking at ${this._userStoppedAt}`);
      this._startTurn(commandText);
      // Play filler phrase — natural thinking sound while brain processes
      this._playFiller(commandText);
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

    this.sttStream.on('transcript:final', ({ text, confidence }) => {
      if (done) return;

      // Apply STT corrections (known misheards) before processing
      let cleaned = sttCorrections.correct(text);

      // Strip wake word from first transcript (buffer replay includes "Razor" audio)
      if (stripNextFinal) {
        cleaned = this._stripWakeWord(cleaned);
        stripNextFinal = false;
      }
      if (cleaned) parts.push(cleaned);

      // Save STT correction and confidence for _startTurn (turn doesn't exist yet)
      if (text !== cleaned && !this._lastSttCorrected) {
        this._lastSttOriginal = text;
        this._lastSttCorrected = cleaned;
      }
      if (confidence != null) {
        this._lastSttConfidence = confidence;
      }

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

    // Replay buffered audio from well before wake detection.
    // Porcupine fires AFTER hearing the full wake word, so the user's
    // command onset can be 300-500ms earlier. Replay 700ms of pre-wake
    // audio to ensure Deepgram captures the first syllable.
    const replayChunks = this._drainAudioRingSince(this._wakeTimestamp - 700);
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

  // ── Play a filler phrase while brain processes ──
  // Picks category based on command content: data queries get "data" fillers,
  // everything else gets "thinking" fillers.
  _playFiller(commandText = '') {
    // Pick filler category based on command content
    const lower = commandText.toLowerCase();
    let category = 'thinking';
    if (/calendar|schedule|meeting|email|inbox|account|dashboard|numbers|data|pipeline|deals/.test(lower)) {
      category = 'data';
    } else if (/how|why|what do you think|opinion|advice/.test(lower)) {
      category = 'conversation';
    }

    if (!fillerPlayer.ready) {
      log.debug('Filler player not ready — skipping filler');
      this._sessionStats.fillerMissed++;
      return;
    }

    const proc = fillerPlayer.play(category);
    this._ackPlayedAt = Date.now();
    this._sessionStats.fillerPlayed++;
    if (this._turn) {
      this._turn.fillerStartMs = Date.now();
      this._turn.fillerText = category;
      this._turn.audioSources.push('filler_armon'); // Telnyx armon voice
    }
    // Track when filler actually finishes (natural end or killed by 1.5s timeout)
    if (proc) {
      proc.on('close', () => {
        if (this._turn && !this._turn.fillerEndMs) {
          this._turn.fillerEndMs = Date.now();
        }
      });
    }
    if (this._userStoppedAt) {
      log.info(`[Latency] Filler started at ${this._ackPlayedAt} — ${this._ackPlayedAt - this._userStoppedAt}ms after user stopped`);
    }
  }

  // ── Dead-code trap: playAck() was removed in v9 ──
  // If anything calls this, it means dead code is still executing.
  // This should never fire — if it does, we have a code path that wasn't cleaned up.
  playAck() {
    log.error('[Voice] DEAD CODE: playAck() called — this method was removed in v9. Fillers replaced acks.');
    if (this._turn) {
      this._turn.deadCodeAckCalled = true;
      this._turn.flags.push('DEAD_CODE_ACK');
    }
  }

  // ── Humanoid Telemetry: Turn Lifecycle ──────────────────────────────────

  _startTurn(rawCommand) {
    this._turnNumber++;
    const now = Date.now();
    this._turn = {
      number: this._turnNumber,
      startedAt: now,
      command: rawCommand,
      sttOriginal: this._lastSttOriginal,
      sttCorrected: this._lastSttCorrected,
      sttConfidence: this._lastSttConfidence != null ? Math.round(this._lastSttConfidence * 100) : -1,
      userSpeechStartedAt: this._wakeTimestamp || now,
      userStoppedAt: this._userStoppedAt || now,
      userSpeechMs: Math.max(0, (this._userStoppedAt || now) - (this._wakeTimestamp || now)),
      fillerStartMs: null,
      fillerEndMs: null,
      fillerText: null,
      brainRequestedAt: null,
      brainFirstChunkAt: null,
      brainRespondedAt: null,
      brainMs: 0,
      dataFetchStartedAt: null,
      dataFetchEndedAt: null,
      dataFetchMs: 0,
      ttsStartMs: null,
      ttsEndMs: null,
      intent: null,
      actions: [],
      spokenText: null,
      cacheHit: false,
      prefetched: false,
      personalityScore: 0,
      personalityEmoji: '',
      personalityGood: [],
      personalityBad: [],
      xpScore: 0,
      xpGrade: 'F',
      xpEmoji: '',
      xpDeductions: [],
      flags: [],
      // ── v9 telemetry ──
      intentSource: null,        // 'cache' | 'llm' | 'pattern'
      priorityBreakdown: null,   // { calendarMs, actionItemsMs, hotLeadsMs, totalMs }
      frankenstein: false,       // true if non-armon audio source detected
      deadCodeAckCalled: false,  // true if dead playAck() trap was triggered
      audioSources: [],          // ['telnyx_armon', 'macos_say', etc.]
    };
    // Reset saved STT values
    this._lastSttConfidence = null;
    this._lastSttOriginal = null;
    this._lastSttCorrected = null;

    this._checkForRepeat(rawCommand, now);
  }

  _endTurn() {
    if (!this._turn) return;
    const t = this._turn;

    // ── Voice consistency audit ──
    // Check audio sources used this turn for Frankenstein detection
    if (t.audioSources.length > 0) {
      const nonArmon = t.audioSources.filter(s => s !== 'telnyx_armon' && s !== 'filler_armon');
      if (nonArmon.length > 0) {
        t.frankenstein = true;
        t.flags.push('FRANKENSTEIN');
        log.warn(`[Voice] FRANKENSTEIN detected — non-armon sources: ${nonArmon.join(', ')}`);
      }
    }

    // Personality audit
    const pa = auditPersonality(t.spokenText);
    t.personalityScore = pa.score;
    t.personalityEmoji = pa.emoji;
    t.personalityGood = pa.good;
    t.personalityBad = pa.bad;

    // Experience score
    const xp = computeExperienceScore(t);
    t.xpScore = xp.score;
    t.xpGrade = xp.grade;
    t.xpEmoji = xp.emoji;
    t.xpDeductions = xp.deductions;

    // Track for session summary
    this._sessionXPScores.push(t.xpScore);

    // Track v9 session stats
    if (t.frankenstein) this._sessionStats.frankensteinCount++;
    if (t.deadCodeAckCalled) this._sessionStats.deadCodeAckCount++;
    if (t.intentSource === 'pattern') this._sessionStats.patternHits++;
    if (t.cacheHit) this._sessionStats.cacheHits++;

    // Log consolidated turn block
    logTurnBlock(t, log);

    // Log conversation rhythm
    this._logRhythm(t);

    this._turn = null;
  }

  _checkForRepeat(command, now) {
    const recent = this._recentCommands;
    for (const prev of recent) {
      if (now - prev.ts < 20_000 && this._isSimilarCommand(command, prev.command)) {
        this._turn.flags.push('repeat_command');
        const repeats = recent.filter(r => now - r.ts < 60_000 && this._isSimilarCommand(command, r.command)).length;
        if (repeats >= 2) this._turn.flags.push('frustration');
        break;
      }
    }
    recent.push({ command, ts: now });
    if (recent.length > 5) recent.shift();
  }

  _isSimilarCommand(a, b) {
    if (!a || !b) return false;
    const na = a.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
    const nb = b.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
    if (na === nb) return true;
    const wa = new Set(na.split(/\s+/));
    const wb = new Set(nb.split(/\s+/));
    let overlap = 0;
    for (const w of wa) { if (wb.has(w)) overlap++; }
    return overlap / Math.max(wa.size, wb.size) >= 0.8;
  }

  _logRhythm(t) {
    this._rhythmData.userSpeechMs.push(t.userSpeechMs);
    const razorMs = (t.ttsEndMs && t.ttsStartMs) ? t.ttsEndMs - t.ttsStartMs : 0;
    this._rhythmData.razorSpeechMs.push(razorMs);
    if (this._turnNumber >= 2) {
      if (!this._rhythmData._firstTurnAt) this._rhythmData._firstTurnAt = t.startedAt;
      const elapsedMin = (t.startedAt - this._rhythmData._firstTurnAt) / 60_000;
      if (elapsedMin > 0) {
        this._rhythmData.turnsPerMinute.push(this._turnNumber / elapsedMin);
      }
    }
    const avgUser = this._rhythmData.userSpeechMs.reduce((a, b) => a + b, 0) / this._rhythmData.userSpeechMs.length;
    const avgRazor = this._rhythmData.razorSpeechMs.length > 0
      ? this._rhythmData.razorSpeechMs.reduce((a, b) => a + b, 0) / this._rhythmData.razorSpeechMs.length
      : 0;
    const ratio = avgRazor > 0 ? (avgUser / avgRazor).toFixed(2) : 'N/A';
    log.info(`[Rhythm] Avg user: ${Math.round(avgUser)}ms | Avg Razor: ${Math.round(avgRazor)}ms | Talk ratio: ${ratio} | Turn ${this._turnNumber}`);
  }

  /**
   * Record an integration call for health tracking.
   * Called from index.js after each dispatch.
   * @param {string} service — e.g. 'google', 'salesforce', 'fellow', 'salesloft'
   * @param {boolean} success
   * @param {number} ms — duration in milliseconds
   */
  recordIntegrationCall(service, success, ms) {
    if (!this._integrationHealth[service]) {
      this._integrationHealth[service] = { success: 0, fail: 0, totalMs: 0, calls: 0 };
    }
    const h = this._integrationHealth[service];
    h.calls++;
    if (success) h.success++; else h.fail++;
    h.totalMs += ms;
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

    // Kill any playing filler or ack before starting real TTS
    fillerPlayer.stop();
    if (this._ackProcess) {
      try { this._ackProcess.kill('SIGKILL'); } catch { /* ignore */ }
      this._ackProcess = null;
    }

    this.sm.transition(States.SPEAKING, 'tts_start');

    // Track filler end and TTS start on turn
    if (this._turn) {
      if (!this._turn.fillerEndMs && this._turn.fillerStartMs) this._turn.fillerEndMs = Date.now();
      this._turn.ttsStartMs = Date.now();
      this._turn.spokenText = text;
    }

    // ── [Humanness] Latency summary ──
    if (this._userStoppedAt) {
      const now = Date.now();
      const totalWait = now - this._userStoppedAt;
      const fillerDelay = this._ackPlayedAt > this._userStoppedAt ? this._ackPlayedAt - this._userStoppedAt : -1;
      log.info(`[Latency] TTS started at ${now} — ${totalWait}ms total wait`);
      log.info(`[Humanness] Total wait: ${totalWait}ms | Filler: ${fillerDelay}ms | TTS: ${totalWait}ms`);
    }

    try {
      const result = await this.tts.synthesize(text, { pace });
      // Track TTS audio source for voice consistency
      if (this._turn && result) {
        const src = result.provider === 'macos_say' ? 'macos_say' : 'telnyx_armon';
        this._turn.audioSources.push(src);
      }
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

  // ── Speak pre-synthesized audio (skips TTS, goes straight to playback) ──
  async speakPreSynthesized(ttsResult, { pace = 'normal' } = {}) {
    if (!ttsResult?.buffer) return;

    followUpMode.exit();

    // Kill any playing filler or ack
    fillerPlayer.stop();
    if (this._ackProcess) {
      try { this._ackProcess.kill('SIGKILL'); } catch { /* ignore */ }
      this._ackProcess = null;
    }

    this.sm.transition(States.SPEAKING, 'tts_pre_synth');

    // Track filler end and TTS start on turn
    if (this._turn) {
      if (!this._turn.fillerEndMs && this._turn.fillerStartMs) this._turn.fillerEndMs = Date.now();
      this._turn.ttsStartMs = Date.now();
    }

    if (this._userStoppedAt) {
      const now = Date.now();
      log.info(`[Latency] Pre-synth TTS started at ${now} — ${now - this._userStoppedAt}ms total wait`);
    }

    try {
      await this.playback.play(ttsResult.buffer, {
        pace,
        format: ttsResult.format || 'mp3',
      });
    } catch (err) {
      log.error('Pre-synth playback failed:', err.message);
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
