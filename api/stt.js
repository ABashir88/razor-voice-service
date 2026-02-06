/**
 * Telnyx Speech-to-Text — REST API.
 * 
 * Sends WAV file to Telnyx AI transcription endpoint.
 * Returns transcribed text string.
 */
import { readFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { log, logError } from '../lib/log.js';

/**
 * Transcribe a WAV file to text via Telnyx STT.
 * @param {string} wavPath - Path to the WAV file
 * @param {object} config - Config object with telnyx.sttEndpoint, telnyx.sttModel
 * @param {string} apiKey - Telnyx API key
 * @returns {string} Transcribed text (empty string if no speech detected)
 */
export async function transcribe(wavPath, config, apiKey) {
  log('🔄', 'Transcribing...');

  const audioData = await readFile(wavPath);
  
  // Skip tiny files (< 1KB = no real audio)
  if (audioData.length < 1024) {
    log('⚠️', 'Audio too short, skipping');
    try { await unlink(wavPath); } catch {}
    return '';
  }

  // Build multipart form data (no npm deps needed)
  const boundary = `----RazorBoundary${randomUUID().replace(/-/g, '')}`;

  const fields = [
    fieldPart(boundary, 'model', config.telnyx.sttModel),
  ];

  const filePart = [
    `--${boundary}\r\n`,
    `Content-Disposition: form-data; name="file"; filename="audio.wav"\r\n`,
    `Content-Type: audio/wav\r\n\r\n`,
  ].join('');

  const header = Buffer.from(fields.join('') + filePart);
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([header, audioData, footer]);

  const resp = await fetch(config.telnyx.sttEndpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`STT ${resp.status}: ${errText.substring(0, 200)}`);
  }

  const data = await resp.json();
  const text = data.text?.trim() || '';

  // Clean up WAV file
  try { await unlink(wavPath); } catch {}

  if (text) {
    log('📝', `"${text.substring(0, 80)}${text.length > 80 ? '...' : ''}"`);
  } else {
    log('⚠️', 'No speech detected');
  }

  return text;
}

function fieldPart(boundary, name, value) {
  return `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
}
