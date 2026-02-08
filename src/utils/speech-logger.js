// src/utils/speech-logger.js
// Comprehensive logging for tuning Razor's natural speech

import makeLogger from './logger.js';

const log = makeLogger('Speech');

/**
 * Log TTS input transformation
 */
export function logTTSInput(original, cleaned, reason) {
  log.info('═══════════════════════════════════════════════════════');
  log.info('  📝 TTS INPUT TRANSFORMATION');
  log.info('═══════════════════════════════════════════════════════');
  log.info(`  Original (${original?.length || 0} chars):`);
  log.info(`    "${original?.slice(0, 150) || '(empty)'}${original?.length > 150 ? '...' : ''}"`);
  if (cleaned !== original) {
    log.info(`  Cleaned (${cleaned?.length || 0} chars):`);
    log.info(`    "${cleaned?.slice(0, 150) || '(empty)'}${cleaned?.length > 150 ? '...' : ''}"`);
    log.info(`  Reason: ${reason || 'standard cleanup'}`);
  }
  log.info('───────────────────────────────────────────────────────');
}

/**
 * Log speech naturalness issues detected
 */
export function logNaturalnessIssues(text, issues) {
  if (!issues || issues.length === 0) return;
  
  log.warn('⚠️  NATURALNESS ISSUES DETECTED:');
  issues.forEach((issue, i) => {
    log.warn(`    ${i + 1}. ${issue.type}: "${issue.match}" → ${issue.suggestion}`);
  });
}

/**
 * Log pacing decision
 */
export function logPacingDecision(text, pace, reason) {
  const paceEmoji = {
    urgent: '⚡',
    normal: '🎯',
    calm: '🌊'
  };
  log.info(`  ${paceEmoji[pace] || '🎤'} Pace: ${pace} — ${reason}`);
}

/**
 * Log audio playback details
 */
export function logPlayback(filename, duration, pace, rate) {
  log.info('  🔊 PLAYBACK:');
  log.info(`     File: ${filename}`);
  log.info(`     Duration: ~${duration}ms`);
  log.info(`     Pace: ${pace}, Rate: ${rate}x`);
}

/**
 * Log entity extraction for context
 */
export function logEntityExtraction(actionName, entities) {
  if (!entities || entities.length === 0) {
    log.info(`  📦 Context: No entities extracted from ${actionName}`);
    return;
  }
  
  log.info(`  📦 CONTEXT ENTITIES (${entities.length}):`);
  entities.slice(0, 5).forEach((e, i) => {
    const details = [];
    if (e.name) details.push(e.name);
    if (e.type) details.push(`[${e.type}]`);
    if (e.company) details.push(`@ ${e.company}`);
    if (e.amount) details.push(`$${e.amount}`);
    log.info(`     ${i + 1}. ${details.join(' ')}`);
  });
  if (entities.length > 5) {
    log.info(`     ... and ${entities.length - 5} more`);
  }
}

/**
 * Log follow-up detection
 */
export function logFollowUpDetection(userText, detected, resolved) {
  if (!detected?.isFollowUp) return;
  
  log.info('  🔗 FOLLOW-UP DETECTED:');
  log.info(`     User: "${userText}"`);
  log.info(`     Action: ${detected.action}`);
  if (resolved) {
    if (resolved.type === 'single') {
      log.info(`     Resolved to: ${resolved.entity?.name || 'unknown'} (${resolved.entity?.type})`);
    } else if (resolved.type === 'multiple') {
      log.info(`     Resolved to: ${resolved.entities?.length} entities`);
    }
  }
}

/**
 * Log complete interaction cycle
 */
export function logInteractionCycle(phase, data) {
  const phaseEmoji = {
    'user_input': '👤',
    'brain_thinking': '🧠',
    'brain_response': '💭',
    'data_fetch': '📊',
    'data_format': '📝',
    'tts_start': '🎤',
    'tts_complete': '✅',
    'playback_start': '🔊',
    'playback_end': '🏁',
    'context_update': '📦',
    'error': '❌'
  };
  
  const emoji = phaseEmoji[phase] || '➡️';
  const timestamp = new Date().toISOString().split('T')[1].slice(0, 12);
  
  log.info(`[${timestamp}] ${emoji} ${phase.toUpperCase()}`);
  
  if (data) {
    if (typeof data === 'string') {
      log.info(`   ${data.slice(0, 100)}${data.length > 100 ? '...' : ''}`);
    } else if (typeof data === 'object') {
      Object.entries(data).forEach(([key, val]) => {
        const valStr = typeof val === 'string' ? val : JSON.stringify(val);
        log.info(`   ${key}: ${valStr.slice(0, 80)}${valStr.length > 80 ? '...' : ''}`);
      });
    }
  }
}

/**
 * Analyze text for naturalness and return issues
 */
export function analyzeNaturalness(text) {
  if (!text) return [];
  
  const issues = [];
  
  // Check for symbols that don't speak well
  const symbolPatterns = [
    { pattern: /\$\d/g, type: 'currency_symbol', suggestion: 'Use "dollars" or "thousand"' },
    { pattern: /%/g, type: 'percent_symbol', suggestion: 'Use "percent"' },
    { pattern: /&/g, type: 'ampersand', suggestion: 'Use "and"' },
    { pattern: /#\d+/g, type: 'hash_number', suggestion: 'Use "number X"' },
    { pattern: /\//g, type: 'slash', suggestion: 'Use "or" or spell out' },
    { pattern: /\d{4}-\d{2}-\d{2}/g, type: 'iso_date', suggestion: 'Use natural date format' },
    { pattern: /\d{2}:\d{2}/g, type: 'time_colon', suggestion: 'Use "X o\'clock" or "X thirty"' },
    { pattern: /[A-Z]{2,}/g, type: 'acronym', suggestion: 'Consider spelling out' },
  ];
  
  symbolPatterns.forEach(({ pattern, type, suggestion }) => {
    const matches = text.match(pattern);
    if (matches) {
      matches.forEach(match => {
        issues.push({ type, match, suggestion });
      });
    }
  });
  
  // Check for robotic patterns
  const roboticPatterns = [
    { pattern: /\bI don't have access\b/i, type: 'disclaimer', suggestion: 'Remove - Razor has access' },
    { pattern: /\bAs an AI\b/i, type: 'ai_reference', suggestion: 'Remove - stay in character' },
    { pattern: /\bI cannot\b/i, type: 'negative', suggestion: 'Use positive framing' },
    { pattern: /\bPlease note\b/i, type: 'formal', suggestion: 'Too formal for voice' },
    { pattern: /\bHere are\b/i, type: 'listy', suggestion: 'Use conversational intro' },
    { pattern: /\bThe following\b/i, type: 'formal', suggestion: 'Too formal for voice' },
  ];
  
  roboticPatterns.forEach(({ pattern, type, suggestion }) => {
    if (pattern.test(text)) {
      const match = text.match(pattern)?.[0];
      issues.push({ type, match, suggestion });
    }
  });
  
  // Check for overly long sentences (hard to follow in speech)
  const sentences = text.split(/[.!?]+/);
  sentences.forEach((sentence, i) => {
    const wordCount = sentence.trim().split(/\s+/).length;
    if (wordCount > 25) {
      issues.push({
        type: 'long_sentence',
        match: `Sentence ${i + 1} (${wordCount} words)`,
        suggestion: 'Break into shorter sentences'
      });
    }
  });
  
  return issues;
}

/**
 * Transform text to be more natural for speech
 */
export function makeNatural(text) {
  if (!text) return text;
  
  let result = text;
  
  // Currency - remove $ symbol, use words
  result = result.replace(/\$(\d+)k\b/gi, '$1 thousand');
  result = result.replace(/\$(\d+),?(\d{3})\b/g, (_, thousands, hundreds) => {
    return `${thousands} thousand ${hundreds ? hundreds + ' ' : ''}dollars`;
  });
  result = result.replace(/\$(\d+)\b/g, '$1 dollars');
  
  // Percentages
  result = result.replace(/(\d+)%/g, '$1 percent');
  
  // Colons in names/titles - replace with spaces or dashes
  result = result.replace(/:\s*/g, ' ');
  
  // Ampersands
  result = result.replace(/\s*&\s*/g, ' and ');
  
  // Slash as "or"
  result = result.replace(/\s*\/\s*/g, ' or ');
  
  // Time formatting
  result = result.replace(/(\d{1,2}):00/g, "$1 o'clock");
  result = result.replace(/(\d{1,2}):30/g, '$1 thirty');
  result = result.replace(/(\d{1,2}):(\d{2})\s*(AM|PM)/gi, '$1 $2 $3');
  
  // Clean up multiple spaces
  result = result.replace(/\s+/g, ' ').trim();
  
  return result;
}

/**
 * Log timing breakdown for latency analysis
 */
export function logTimingBreakdown(timings) {
  log.info('  ⏱️  TIMING BREAKDOWN:');
  
  const total = Object.values(timings).reduce((a, b) => a + b, 0);
  
  Object.entries(timings).forEach(([phase, ms]) => {
    const pct = ((ms / total) * 100).toFixed(0);
    const bar = '█'.repeat(Math.ceil(pct / 5));
    log.info(`     ${phase.padEnd(15)} ${ms.toString().padStart(5)}ms ${bar} ${pct}%`);
  });
  
  log.info(`     ${'TOTAL'.padEnd(15)} ${total.toString().padStart(5)}ms`);
}

export default {
  logTTSInput,
  logNaturalnessIssues,
  logPacingDecision,
  logPlayback,
  logEntityExtraction,
  logFollowUpDetection,
  logInteractionCycle,
  analyzeNaturalness,
  makeNatural,
  logTimingBreakdown
};
