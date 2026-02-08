/**
 * Telnyx Text-to-Speech — REST API.
 * 
 * Sends text to Telnyx TTS endpoint, returns MP3 audio buffer.
 * Handles chunking for long text (NaturalHD has ~1000 char limit).
 * Cleans markdown artifacts for natural speech.
 */
import { log, logError } from '../lib/log.js';

/**
 * Synthesize text to speech via Telnyx TTS.
 * For long text, splits at sentence boundaries and concatenates audio.
 * 
 * @param {string} text - Text to synthesize
 * @param {object} config - Config with telnyx.ttsEndpoint, telnyx.ttsVoice, telnyx.ttsMaxChars
 * @param {string} apiKey - Telnyx API key
 * @param {object} moodParams - Optional mood-based TTS params { pace, pitch }
 * @returns {Buffer} MP3 audio buffer
 */
export async function synthesize(text, config, apiKey, moodParams = {}) {
  // Clean markdown for voice
  const clean = cleanForSpeech(text);
  if (!clean) return null;

  const { pace = 'normal', pitch = 'normal' } = moodParams;
  if (pace !== 'normal' || pitch !== 'normal') {
    log('🔊', `Mood TTS: pace=${pace}, pitch=${pitch}`);
  }

  const maxChars = config.telnyx.ttsMaxChars || 950;
  const voice = config.telnyx.ttsVoice;

  // If short enough, single request
  if (clean.length <= maxChars) {
    return await ttsRequest(clean, voice, config.telnyx.ttsEndpoint, apiKey);
  }

  // Split into chunks at sentence boundaries
  const chunks = splitSentences(clean, maxChars);
  log('🔊', `Long text: ${clean.length} chars → ${chunks.length} chunks`);

  const audioBuffers = [];
  for (const chunk of chunks) {
    const audio = await ttsRequest(chunk, voice, config.telnyx.ttsEndpoint, apiKey);
    if (audio) audioBuffers.push(audio);
  }

  return Buffer.concat(audioBuffers);
}

/**
 * Single TTS API request.
 */
async function ttsRequest(text, voice, endpoint, apiKey) {
  log('🔊', `Synth ${text.length} chars...`);

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg',
    },
    body: JSON.stringify({ voice, text }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`TTS ${resp.status}: ${errText.substring(0, 200)}`);
  }

  return Buffer.from(await resp.arrayBuffer());
}

/**
 * Split text into chunks at sentence boundaries.
 */
function splitSentences(text, maxLen) {
  const sentences = text.match(/[^.!?]+[.!?]+\s*/g) || [text];
  const chunks = [];
  let current = '';

  for (const sentence of sentences) {
    if ((current + sentence).length > maxLen && current) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current += sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  // Safety: if any chunk still exceeds maxLen, hard-split
  const final = [];
  for (const chunk of chunks) {
    if (chunk.length <= maxLen) {
      final.push(chunk);
    } else {
      for (let i = 0; i < chunk.length; i += maxLen) {
        final.push(chunk.substring(i, i + maxLen));
      }
    }
  }

  return final;
}

/**
 * Clean text for voice output.
 * Strips markdown, emojis, tables, code blocks.
 * Formats phone numbers, emails, dollars for speech.
 */
export function cleanForSpeech(text) {
  if (!text) return '';

  let clean = text
    // Remove code blocks
    .replace(/```[\s\S]*?```/g, '')
    // Remove markdown tables
    .replace(/\|[^\n]+\|/g, '')
    .replace(/[-|]+[-|]+/g, '')
    // Remove headers
    .replace(/#{1,6}\s/g, '')
    // Bold/italic → plain
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    // Inline code → plain
    .replace(/`([^`]+)`/g, '$1')
    // Links → just text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Emojis
    .replace(/[🔥🟠🟡⚠️📧📤📊✅❌📅💡🔴🔄📋🎯🔪📝🤖🔌🔊🎤☕🌙📍🏗️💬👋⏰🔇🏆🚀💰🎉🤝📱📞🖥️📈📉⭐🆘🔒]/gu, '')
    // Bullet points
    .replace(/^[-*]\s/gm, '')
    // Multiple newlines
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // ── Voice formatting ──

  // Phone: (xxx) xxx-xxxx or xxx-xxx-xxxx → spoken with pauses
  clean = clean.replace(/\(?(\d{3})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})/g, (_, a, b, c) => {
    return `${a}... ${b}... ${c}`;
  });

  // Email: user@domain.com → "user at domain dot com"
  clean = clean.replace(/(\S+)@(\S+)\.(\S+)/g, '$1 at $2 dot $3');

  // Dollar amounts with K: $60K → sixty thousand dollars
  clean = clean.replace(/\$(\d+)K/g, (_, n) => `${numberToWords(parseInt(n))} thousand dollars`);
  clean = clean.replace(/\$(\d+)M/g, (_, n) => `${numberToWords(parseInt(n))} million dollars`);
  
  // Percentage
  clean = clean.replace(/(\d+)%/g, '$1 percent');

  // "S0", "S1" stage references
  clean = clean.replace(/\bS(\d)\b/g, 'Stage $1');

  // NO_REPLY special token
  if (clean === 'NO_REPLY' || clean === 'HEARTBEAT_OK') return '';

  return clean;
}

function numberToWords(n) {
  const ones = ['zero','one','two','three','four','five','six','seven','eight','nine',
    'ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen'];
  const tens = ['','','twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'];
  
  if (n < 20) return ones[n];
  if (n < 100) return tens[Math.floor(n/10)] + (n%10 ? '-' + ones[n%10] : '');
  if (n < 1000) return ones[Math.floor(n/100)] + ' hundred' + (n%100 ? ' ' + numberToWords(n%100) : '');
  return String(n);
}
