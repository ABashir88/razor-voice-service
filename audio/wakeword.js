/**
 * Wake Word + VAD — Always-listening pipeline.
 * 
 * Uses Porcupine for wake word detection ("Razor" or fallback built-in).
 * Uses energy-based VAD to detect end of speech after wake word.
 * 
 * Flow:
 *   1. Continuous audio stream from Ortizan mic via sox/rec
 *   2. Feed 512-sample frames to Porcupine
 *   3. Wake word detected → start buffering
 *   4. VAD detects 2.5s silence → stop buffering
 *   5. Save buffer as WAV → callback
 * 
 * Requires: PICOVOICE_ACCESS_KEY environment variable
 *           @picovoice/porcupine-node npm package
 */
import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { log, logError } from '../lib/log.js';

const TMP_DIR = join(tmpdir(), 'razor-voice');
const SAMPLE_RATE = 16000;
const FRAME_LENGTH = 512;           // Porcupine's required frame size
const BYTES_PER_FRAME = FRAME_LENGTH * 2;  // 16-bit = 2 bytes per sample
const SILENCE_THRESHOLD = 200;       // RMS below this = silence (tunable)
const SILENCE_DURATION_MS = 2500;    // 2.5 seconds of silence = end of speech
const MAX_UTTERANCE_MS = 60000;      // Max 60 seconds per utterance
const POST_WAKE_BUFFER_MS = 300;     // Skip 300ms after wake word (the word itself)

export class WakeWordListener {
  constructor(config) {
    this.config = config;
    this.porcupine = null;
    this.recProcess = null;
    this.running = false;
    this.listening = false;          // Actively buffering post-wake-word
    this.blocked = false;            // Blocked during TTS playback
    this.onUtterance = null;         // Callback: (wavPath) => void
    this.onWake = null;              // Callback: () => void (wake word detected)
    this._audioBuffer = [];          // Buffered PCM frames during utterance
    this._silenceStart = null;
    this._utteranceStart = null;
    this._postWakeSkip = false;
    this._residual = Buffer.alloc(0); // Leftover bytes between chunks

    // Barge-in / interruption detection during TTS playback
    this.interruptMode = false;      // Monitoring for voice during playback
    this._interruptCount = 0;        // Consecutive frames above threshold
    this._interruptFrames = [];      // Buffered frames during interrupt detection
    this.onInterrupt = null;         // Callback: () => void (barge-in detected)
  }

  /**
   * Initialize Porcupine wake word engine.
   */
  async init() {
    const accessKey = process.env.PICOVOICE_ACCESS_KEY;
    if (!accessKey) {
      log('⚠️', 'PICOVOICE_ACCESS_KEY not set — wake word disabled');
      log('⚠️', 'Get free key: https://console.picovoice.ai/');
      return false;
    }

    try {
      // Dynamic import since it's a CJS module
      const { Porcupine, BuiltinKeyword } = await import('@picovoice/porcupine-node');

      const customKeywordPath = this.config.wakeword?.customModelPath;
      const sensitivity = this.config.wakeword?.sensitivity || 0.6;

      if (customKeywordPath) {
        // Custom "Razor" wake word
        log('🎯', `Wake word: custom model (${customKeywordPath})`);
        this.porcupine = new Porcupine(accessKey, [customKeywordPath], [sensitivity]);
      } else {
        // Built-in fallback — use JARVIS
        const keyword = this.config.wakeword?.builtinKeyword || 'JARVIS';
        log('🎯', `Wake word: "${keyword}" (built-in)`);
        this.porcupine = new Porcupine(
          accessKey,
          [BuiltinKeyword[keyword]],
          [sensitivity]
        );
      }

      log('✅', `Porcupine ready (frame=${this.porcupine.frameLength}, rate=${this.porcupine.sampleRate})`);
      return true;
    } catch (err) {
      logError('Porcupine init failed', err);
      return false;
    }
  }

  /**
   * Start continuous listening via sox/rec piped to Porcupine.
   * rec outputs raw PCM 16-bit signed LE mono 16kHz to stdout.
   */
  start() {
    if (this.running) return;
    // Works without Porcupine — audio stream enables voice interrupt detection during playback
    this.running = true;
    this._startAudioStream();
    log('👂', this.porcupine ? 'Always-listening active' : 'Audio monitor active (voice interruption detection)');
  }

  _startAudioStream() {
    // rec outputs raw PCM to stdout — no file, continuous stream
    this.recProcess = spawn('rec', [
      '-q',
      '-t', 'raw',          // Raw PCM output (no WAV header)
      '-r', String(SAMPLE_RATE),
      '-c', '1',             // Mono
      '-b', '16',            // 16-bit
      '-e', 'signed-integer',
      '-L',                  // Little-endian
      '-',                   // Output to stdout
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    this.recProcess.stdout.on('data', (chunk) => {
      this._processChunk(chunk);  // Block/interrupt logic handled inside
    });

    this.recProcess.on('error', (err) => {
      logError('Audio stream error', err);
      if (this.running) {
        setTimeout(() => this._startAudioStream(), 2000);
      }
    });

    this.recProcess.on('close', () => {
      if (this.running) {
        log('🔄', 'Audio stream closed — restarting...');
        setTimeout(() => this._startAudioStream(), 1000);
      }
    });
  }

  /**
   * Process incoming raw PCM data.
   * Extracts 512-sample frames, feeds to Porcupine or VAD.
   */
  _processChunk(chunk) {
    // Combine with any leftover bytes from previous chunk
    const data = this._residual.length > 0
      ? Buffer.concat([this._residual, chunk])
      : chunk;

    let offset = 0;

    while (offset + BYTES_PER_FRAME <= data.length) {
      const frameBuffer = data.subarray(offset, offset + BYTES_PER_FRAME);
      const frame = new Int16Array(FRAME_LENGTH);
      for (let i = 0; i < FRAME_LENGTH; i++) {
        frame[i] = frameBuffer.readInt16LE(i * 2);
      }
      offset += BYTES_PER_FRAME;

      if (this.interruptMode) {
        // Playback active — monitor for Al's voice (barge-in)
        this._checkInterrupt(frame, frameBuffer);
      } else if (this.blocked) {
        // Fully blocked — skip frame
        continue;
      } else if (this.listening) {
        // Capturing utterance (post-wake-word or post-interrupt)
        this._audioBuffer.push(Buffer.from(frameBuffer));
        this._checkVAD(frame);
      } else {
        // Listening for wake word
        this._checkWakeWord(frame);
      }
    }

    // Save leftover bytes for next chunk
    this._residual = data.subarray(offset);
  }

  /**
   * Feed a frame to Porcupine for wake word detection.
   */
  _checkWakeWord(frame) {
    if (!this.porcupine) return;  // Monitor-only mode — no wake word engine
    try {
      const keywordIndex = this.porcupine.process(frame);
      if (keywordIndex >= 0) {
        log('🎯', 'WAKE WORD DETECTED');
        this.onWake?.();
        this._startUtterance();
      }
    } catch (err) {
      // Porcupine can throw on malformed frames — ignore
    }
  }

  /**
   * Check for barge-in during TTS playback.
   * Uses higher energy threshold to filter speaker bleed from Mac mini speakers.
   * Requires consecutive frames above threshold to avoid transient triggers.
   */
  _checkInterrupt(frame, frameBuffer) {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) {
      sum += frame[i] * frame[i];
    }
    const rms = Math.sqrt(sum / frame.length);
    const threshold = this.config.wakeword?.interruptThreshold || 500;
    const debounce = this.config.wakeword?.interruptDebounce || 3;

    if (rms > threshold) {
      this._interruptFrames.push(Buffer.from(frameBuffer));
      this._interruptCount++;
      if (this._interruptCount >= debounce) {
        log('🛑', `BARGE-IN detected (RMS: ${Math.round(rms)}, frames: ${this._interruptCount})`);

        // Transition: interrupt mode → utterance capture
        this.interruptMode = false;
        this.blocked = false;

        // Start utterance pre-seeded with the frames that triggered the interrupt
        this.listening = true;
        this._audioBuffer = [...this._interruptFrames];
        this._silenceStart = null;
        this._utteranceStart = Date.now();
        this._postWakeSkip = false;
        this._interruptFrames = [];
        this._interruptCount = 0;

        // Notify main.js to kill playback immediately
        this.onInterrupt?.();
      }
    } else {
      this._interruptCount = 0;
      this._interruptFrames = [];
    }
  }

  /**
   * Start buffering utterance after wake word.
   */
  _startUtterance() {
    this.listening = true;
    this._audioBuffer = [];
    this._silenceStart = null;
    this._utteranceStart = Date.now();
    this._postWakeSkip = true;

    // Skip the wake word echo (300ms)
    setTimeout(() => {
      this._postWakeSkip = false;
    }, POST_WAKE_BUFFER_MS);
  }

  /**
   * Energy-based VAD — detect silence to end utterance.
   */
  _checkVAD(frame) {
    if (this._postWakeSkip) return;

    // Calculate RMS energy
    let sum = 0;
    for (let i = 0; i < frame.length; i++) {
      sum += frame[i] * frame[i];
    }
    const rms = Math.sqrt(sum / frame.length);

    const now = Date.now();

    if (rms < SILENCE_THRESHOLD) {
      // Silence
      if (!this._silenceStart) {
        this._silenceStart = now;
      } else if (now - this._silenceStart >= SILENCE_DURATION_MS) {
        // Enough silence — end utterance
        this._endUtterance();
        return;
      }
    } else {
      // Speech — reset silence counter
      this._silenceStart = null;
    }

    // Max duration safety
    if (now - this._utteranceStart >= MAX_UTTERANCE_MS) {
      log('⚠️', 'Max utterance duration reached');
      this._endUtterance();
    }
  }

  /**
   * End utterance — save buffered audio as WAV and fire callback.
   */
  async _endUtterance() {
    this.listening = false;
    const frames = this._audioBuffer;
    this._audioBuffer = [];
    this._silenceStart = null;
    this._utteranceStart = null;

    if (frames.length === 0) return;

    // Trim trailing silence (remove last ~2.5s worth of frames)
    const silenceFrames = Math.ceil(SILENCE_DURATION_MS / (FRAME_LENGTH / SAMPLE_RATE * 1000));
    const trimmedFrames = frames.slice(0, Math.max(1, frames.length - silenceFrames));

    const pcmData = Buffer.concat(trimmedFrames);

    // Skip if too short (< 0.5s of audio)
    if (pcmData.length < SAMPLE_RATE * 2 * 0.5) {
      log('⚠️', 'Utterance too short, ignoring');
      return;
    }

    // Write WAV file
    await mkdir(TMP_DIR, { recursive: true });
    const wavPath = join(TMP_DIR, `wake-${Date.now()}.wav`);
    const wavBuffer = createWav(pcmData, SAMPLE_RATE, 1, 16);
    await writeFile(wavPath, wavBuffer);

    const durationSec = (pcmData.length / (SAMPLE_RATE * 2)).toFixed(1);
    log('📝', `Utterance: ${durationSec}s → ${wavPath}`);

    // Fire callback
    this.onUtterance?.(wavPath);
  }

  /**
   * Block listening (during TTS playback).
   * Instead of full block, enters interrupt detection mode so Al can barge in.
   */
  block() {
    this.blocked = true;
    this.interruptMode = true;       // Monitor for barge-in instead of full block
    this._interruptCount = 0;
    this._interruptFrames = [];
    if (this.listening) {
      // Cancel current utterance — it would pick up speaker output
      this.listening = false;
      this._audioBuffer = [];
      this._silenceStart = null;
    }
  }

  /**
   * Unblock listening (after TTS playback + reverb buffer).
   */
  unblock() {
    this.blocked = false;
    this.interruptMode = false;
    this._interruptCount = 0;
    this._interruptFrames = [];
  }

  /**
   * Stop everything.
   */
  stop() {
    this.running = false;
    this.listening = false;
    if (this.recProcess) {
      this.recProcess.kill('SIGKILL');
      this.recProcess = null;
    }
    if (this.porcupine) {
      try { this.porcupine.release(); } catch {}
      this.porcupine = null;
    }
    log('🔇', 'Wake word listener stopped');
  }

  get isListening() { return this.listening; }
  get isRunning() { return this.running; }
}

/**
 * Create a WAV file buffer from raw PCM data.
 */
function createWav(pcmData, sampleRate, channels, bitsPerSample) {
  const byteRate = sampleRate * channels * bitsPerSample / 8;
  const blockAlign = channels * bitsPerSample / 8;
  const dataSize = pcmData.length;
  const headerSize = 44;
  const buffer = Buffer.alloc(headerSize + dataSize);

  // RIFF header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);

  // fmt chunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);          // chunk size
  buffer.writeUInt16LE(1, 20);           // PCM format
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  // data chunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  pcmData.copy(buffer, 44);

  return buffer;
}
