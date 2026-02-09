// src/utils/humanoid-metrics.js — Humanoid evaluation telemetry
//
// Measures how HUMAN each interaction feels. Log-only — no logic changes.
//
// Exports:
//   auditPersonality(text) → { score, emoji, issues, good }
//   computeExperienceScore(turn) → { score, grade, emoji, deductions }
//   logTurnBlock(turn, logger) — logs the consolidated turn block
//   buildTimeline(turn) → string — audio timeline visualization

import makeLogger from './logger.js';

const log = makeLogger('Humanoid');

// ── Response Personality Audit ──────────────────────────────────────────

export function auditPersonality(text) {
  if (!text || text.length < 2 || text === '.') {
    return { score: 0, emoji: '🔴', issues: ['silent'], good: [], bad: ['silent'] };
  }

  const issues = [];
  const good = [];

  // ── BAD SIGNS ──
  if (/I'd be happy to|I can help|How can I assist/i.test(text)) issues.push('corporate');
  if (/I think|It seems|It appears|might be|could be/i.test(text)) issues.push('hedging');
  if (/I'm sorry|I apologize|Unfortunately/i.test(text)) issues.push('apologetic');
  const sentenceCount = (text.match(/[.!?]+/g) || []).length;
  if (sentenceCount > 5) issues.push(`verbose(${sentenceCount}sent)`);
  if (/you asked|your question|you wanted/i.test(text)) issues.push('parroting');
  const wordCount = text.split(/\s+/).length;
  if (wordCount > 50) issues.push(`long(${wordCount}w)`);
  if (/\b[1-9]\.\s/m.test(text)) issues.push('numbered_list');
  if (/null|undefined|NaN|\[\]|\{\}/i.test(text)) issues.push('raw_data_leak');
  if (/\*\*|__|##|```/.test(text)) issues.push('markdown_in_voice');

  // ── GOOD SIGNS ──
  if (/^(So|Alright|Here's|Quick|Yeah|Got|Okay|Right|Looks like)/i.test(text)) good.push('natural_opener');
  if (/you've|they're|we're|it's|that's|here's|what's|can't|won't|don't/i.test(text)) good.push('contractions');
  if (wordCount <= 20) good.push('punchy');
  if (/\d/.test(text)) good.push('has_data');
  if (/[A-Z][a-z]+\s[A-Z][a-z]+/.test(text)) good.push('has_names');

  const score = Math.max(0, Math.min(10, 7 + good.length - (issues.length * 2)));
  const emoji = score >= 8 ? '🟢' : score >= 5 ? '🟡' : '🔴';

  return { score, emoji, issues, good, bad: issues };
}

// ── Experience Score Calculator ─────────────────────────────────────────

export function computeExperienceScore(t) {
  let score = 100;
  const deductions = [];

  // ── LATENCY ──
  const totalWait = t.ttsStartMs && t.userStoppedAt
    ? t.ttsStartMs - t.userStoppedAt
    : 9999;
  if (totalWait > 5000) { score -= 30; deductions.push(`wait${Math.round(totalWait / 1000)}s(-30)`); }
  else if (totalWait > 3000) { score -= 15; deductions.push(`wait${Math.round(totalWait / 1000)}s(-15)`); }
  else if (totalWait > 2000) { score -= 5; deductions.push(`wait${Math.round(totalWait / 1000)}s(-5)`); }
  else if (totalWait < 1500) { score += 10; deductions.push('fast(+10)'); }

  // ── DEAD AIR ──
  if (t.fillerEndMs && t.ttsStartMs) {
    const gap = t.ttsStartMs - t.fillerEndMs;
    if (gap > 2000) { score -= 20; deductions.push(`deadair${Math.round(gap / 1000)}s(-20)`); }
    else if (gap > 1000) { score -= 10; deductions.push(`deadair${Math.round(gap / 1000)}s(-10)`); }
  }
  if (!t.fillerStartMs && totalWait > 1500) { score -= 10; deductions.push('no_filler(-10)'); }

  // ── RESPONSE QUALITY ──
  const wordCount = (t.spokenText || '').split(/\s+/).filter(Boolean).length;
  if (t.actions.length > 0 && !t.actions.some(a => a.succeeded)) { score -= 25; deductions.push('action_fail(-25)'); }
  if (wordCount === 0) { score -= 30; deductions.push('silent(-30)'); }
  if (wordCount > 50) { score -= 10; deductions.push(`verbose${wordCount}w(-10)`); }
  if (t.personalityScore !== undefined && t.personalityScore < 5) { score -= 10; deductions.push('robotic(-10)'); }

  // ── BONUSES ──
  if (t.cacheHit) { score += 5; deductions.push('cache(+5)'); }
  if (t.sttCorrected) { score += 3; deductions.push('stt_fix(+3)'); }
  if (t.brainFirstChunkAt && t.brainRequestedAt) {
    const streamLatency = t.brainFirstChunkAt - t.brainRequestedAt;
    if (streamLatency < 1200) { score += 5; deductions.push('fast_stream(+5)'); }
  }

  // ── V9 FACTORS ──
  if (t.frankenstein) { score -= 20; deductions.push('FRANKENSTEIN(-20)'); }
  if (t.deadCodeAckCalled) { score -= 15; deductions.push('DEAD_CODE_ACK(-15)'); }
  if (t.intentSource === 'pattern') { score += 5; deductions.push('pattern_hit(+5)'); }
  if (t.priorityBreakdown) {
    const pb = t.priorityBreakdown;
    const failedSubs = [pb.calendarMs, pb.actionItemsMs, pb.hotLeadsMs].filter(ms => ms === -1).length;
    if (failedSubs > 0) { score -= 5 * failedSubs; deductions.push(`priority_partial(${failedSubs}x-5)`); }
    if (pb.totalMs > 0 && pb.totalMs < 3000) { score += 5; deductions.push('fast_priority(+5)'); }
  }

  const clamped = Math.max(0, Math.min(100, score));
  const grade = clamped >= 90 ? 'A' : clamped >= 75 ? 'B' : clamped >= 60 ? 'C' : clamped >= 40 ? 'D' : 'F';
  const emoji = clamped >= 90 ? '🌟' : clamped >= 75 ? '🟢' : clamped >= 60 ? '🟡' : clamped >= 40 ? '🟠' : '🔴';

  return { score: clamped, grade, emoji, deductions };
}

// ── Audio Timeline Builder ──────────────────────────────────────────────

export function buildTimeline(t) {
  const parts = [];

  // User speech
  parts.push(`[user ${(t.userSpeechMs / 1000).toFixed(1)}s]`);

  // Gap from user stop to first audio (filler or response)
  const firstAudioAt = t.fillerStartMs || t.ttsStartMs || 0;
  const gapToFirstAudio = firstAudioAt && t.userStoppedAt ? firstAudioAt - t.userStoppedAt : 0;
  if (gapToFirstAudio > 0) {
    const gapLabel = gapToFirstAudio > 1500 ? `⚠️${gapToFirstAudio}ms` : `${gapToFirstAudio}ms`;
    parts.push(`─${gapLabel}─`);
  }

  // Filler (if played)
  if (t.fillerStartMs && t.fillerEndMs) {
    const fillerDur = t.fillerEndMs - t.fillerStartMs;
    parts.push(`[filler ${(fillerDur / 1000).toFixed(1)}s]`);

    if (t.ttsStartMs) {
      const fillerGap = t.ttsStartMs - t.fillerEndMs;
      if (fillerGap > 0) {
        const gapLabel = fillerGap > 1500 ? `⚠️${fillerGap}ms` : `${fillerGap}ms`;
        parts.push(`─${gapLabel}─`);
      }
    }
  }

  // Response
  if (t.ttsStartMs && t.ttsEndMs) {
    const ttsDur = t.ttsEndMs - t.ttsStartMs;
    parts.push(`[response ${(ttsDur / 1000).toFixed(1)}s]`);
  } else if (!t.spokenText || t.spokenText === '.') {
    parts.push('[SILENT]');
  }

  // Total user-perceived wait
  const totalWait = t.ttsStartMs && t.userStoppedAt
    ? t.ttsStartMs - t.userStoppedAt
    : -1;
  parts.push(`(total wait: ${totalWait}ms)`);

  return parts.join('');
}

// ── Turn Block Logger ───────────────────────────────────────────────────

export function logTurnBlock(t, logger) {
  const l = logger || log;
  const lines = [];

  lines.push(`[Turn] ═══ TURN ${t.number} ═══════════════════════════════════════`);

  // Silent turn banner — must be unmissable (Week 1 KPI #1)
  // Only check spokenText — brainText is "." for pattern-matched turns (expected, not silent)
  const _isSilent = !t.spokenText || t.spokenText.trim() === '' || t.spokenText.trim() === '.';
  if (_isSilent) {
    lines.push('[Turn] ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓');
    lines.push('[Turn] ┃  🔇 SILENT TURN — No spoken output    ┃');
    lines.push('[Turn] ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛');
  }

  // 1. What the user said
  const sttFix = t.sttCorrected ? ` (STT fixed: "${t.sttOriginal}" → "${t.sttCorrected}")` : '';
  lines.push(`[Turn] 🎤 User: "${t.command}" (${t.userSpeechMs}ms speech, confidence ${t.sttConfidence}%)${sttFix}`);

  // 2. Audio timeline
  const timeline = buildTimeline(t);
  lines.push(`[Turn] 🎵 ${timeline}`);

  // 3. Brain + Action
  const cacheTag = t.cacheHit ? '♻️ CACHE' : t.prefetched ? '⚡ PREFETCH' : '🌐 LIVE';
  const intentTag = t.intentSource === 'pattern' ? '⚡ PATTERN' : t.intentSource === 'cache' ? '♻️ CACHE' : '🧠 LLM';
  const actionStr = t.actions.length > 0
    ? t.actions.map(a => {
        const p = a.params && Object.keys(a.params).length > 0
          ? '(' + Object.entries(a.params).map(([k, v]) => `${k}=${v}`).join(', ') + ')'
          : '';
        return `${a.action}${p}(${a.succeeded ? '✓' : '✗'})`;
      }).join(', ')
    : 'no_action';
  lines.push(`[Turn] 🧠 Brain: ${t.intent} → ${actionStr} [${intentTag}] [${cacheTag}] (brain: ${t.brainMs}ms, data: ${t.dataFetchMs}ms)`);

  // 3a. Pattern match detail
  if (t.intentSource === 'pattern') {
    const _transcript = (t.userText || t.rawCommand || t.command || '').slice(0, 50);
    const _action = (t.actions.length > 0 && t.actions[0].action) || t.intent || 'unknown';
    lines.push(`[Turn] ⚡ Pattern: "${_transcript}" matched → ${_action} (skipped LLM, saved ~2500ms)`);
  }

  // 3b. Priority breakdown (if this was a get_priorities action)
  if (t.priorityBreakdown) {
    const pb = t.priorityBreakdown;
    lines.push(`[Priority] 📊 cal: ${pb.calendarMs}ms | items: ${pb.actionItemsMs}ms | leads: ${pb.hotLeadsMs}ms | total: ${pb.totalMs}ms`);
  }

  // 4. What Razor actually said
  const wordCount = (t.spokenText || '').split(/\s+/).filter(Boolean).length;
  const estDuration = (wordCount / 2.5).toFixed(1);
  const truncated = (t.spokenText || '').length > 80
    ? t.spokenText.slice(0, 80) + '...'
    : t.spokenText || '(silent)';
  lines.push(`[Turn] 🔊 Razor: "${truncated}" (${wordCount}w, ~${estDuration}s)`);

  // 5. Personality
  lines.push(`[Turn] 📏 Personality: ${t.personalityEmoji} ${t.personalityScore}/10 [${t.personalityGood.join(', ') || '-'}] [${t.personalityBad.join(', ') || '-'}]`);

  // 6. Experience score
  lines.push(`[Turn] ⚡ XP: ${t.xpEmoji} ${t.xpGrade} (${t.xpScore}/100) | ${t.xpDeductions.join(' ')}`);

  // 7. Flags
  if (t.flags.length > 0) {
    lines.push(`[Turn] 🚩 Flags: ${t.flags.join(', ')}`);
  }

  lines.push(`[Turn] ═══════════════════════════════════════════════════════════`);

  for (const line of lines) {
    l.info(line);
  }
}
