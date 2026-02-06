// src/wake-word/transcript-detector.js – Wake word detection via STT transcript
//
// Fallback wake word detection when Porcupine API key is not available.
// Flow:
//   1. VAD detects speech → emits PCM audio
//   2. This module sends audio to Deepgram STT for transcription
//   3. Checks if transcript contains the wake word "razor"
//   4. If found: emits 'wake' with the full transcript (minus the wake word)
//   5. If not found: discards silently
//
// Uses Deepgram's pre-recorded (batch) API for short utterances.
// For always-listening, this is called on every VAD speech segment.

import { Buffer } from 'buffer';
import EventEmitter from 'eventemitter3';
import config from '../config.js';
import makeLogger from '../utils/logger.js';

const log = makeLogger('WakeTranscript');

class TranscriptWakeDetector extends EventEmitter {
  constructor() {
    super();
    this.wakeWord = config.wakeWord.keyword.toLowerCase();
    this.apiKey = config.stt.deepgramApiKey;
    this.enabled = true;
  }

  // ── Build WAV file from raw PCM data ──
  buildWav(pcmBuffer, sampleRate = 16000, channels = 1, bitDepth = 16) {
    const byteRate = sampleRate * channels * (bitDepth / 8);
    const blockAlign = channels * (bitDepth / 8);
    const dataSize = pcmBuffer.length;
    const headerSize = 44;
    const fileSize = headerSize + dataSize;

    const header = Buffer.alloc(headerSize);

    // RIFF header
    header.write('RIFF', 0);
    header.writeUInt32LE(fileSize - 8, 4);
    header.write('WAVE', 8);

    // fmt chunk
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);       // chunk size
    header.writeUInt16LE(1, 20);        // PCM format
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitDepth, 34);

    // data chunk
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    return Buffer.concat([header, pcmBuffer]);
  }

  // ── Send audio to Deepgram for transcription ──
  async transcribe(pcmBuffer) {
    if (!this.apiKey) {
      log.error('No Deepgram API key configured. Set DEEPGRAM_API_KEY in .env');
      return null;
    }

    const wavBuffer = this.buildWav(pcmBuffer);

    try {
      const response = await fetch(
        'https://api.deepgram.com/v1/listen?' +
          new URLSearchParams({
            model: 'nova-2',
            language: 'en',
            smart_format: 'true',
            keywords: `${this.wakeWord}:2`,  // boost wake word recognition
          }),
        {
          method: 'POST',
          headers: {
            Authorization: `Token ${this.apiKey}`,
            'Content-Type': 'audio/wav',
          },
          body: wavBuffer,
        }
      );

      if (!response.ok) {
        const text = await response.text();
        log.error(`Deepgram error ${response.status}: ${text}`);
        return null;
      }

      const data = await response.json();
      const transcript =
        data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';

      return transcript.trim();
    } catch (err) {
      log.error('Deepgram transcription failed:', err.message);
      return null;
    }
  }

  // ── Check speech segment for wake word ──
  // Called by the pipeline when VAD emits speech:end
  async checkAudio({ audio, durationMs }) {
    if (!this.enabled) return;

    // Skip very short segments (unlikely to contain wake word)
    if (durationMs < 400) {
      log.debug(`Skipping short segment (${durationMs}ms)`);
      return;
    }

    log.debug(`Transcribing ${(durationMs / 1000).toFixed(1)}s segment...`);

    const transcript = await this.transcribe(audio);
    if (!transcript) return;

    log.info(`Transcript: "${transcript}"`);

    // Check if transcript contains wake word
    const lower = transcript.toLowerCase();

    // Match variations: "razor", "razer", "raze her", "raise or"
    const wakePatterns = [
      this.wakeWord,
      'razer',
      'raze her',
      'raise or',
      'razor.',
      'razor,',
      'razor!',
      'hey razor',
    ];

    const foundPattern = wakePatterns.find((p) => lower.includes(p));

    if (foundPattern) {
      // Extract the command after the wake word
      const wakeIndex = lower.indexOf(foundPattern);
      const afterWake = transcript.slice(wakeIndex + foundPattern.length).trim();

      // Remove leading punctuation
      const command = afterWake.replace(/^[.,!?\s]+/, '').trim();

      log.info(`🎯 Wake word detected! Pattern: "${foundPattern}", Command: "${command || '(waiting for command)'}"`);

      this.emit('wake', {
        transcript,
        command,
        pattern: foundPattern,
        audio,
        durationMs,
      });
    } else {
      log.debug(`No wake word found — discarding`);
      this.emit('reject', { transcript });
    }
  }

  disable() {
    this.enabled = false;
  }

  enable() {
    this.enabled = true;
  }
}

export default TranscriptWakeDetector;
