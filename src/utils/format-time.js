// src/utils/format-time.js — TTS-safe time formatting
//
// No colons — humanizeResponse replaces : with , which sounds wrong.
// "7 PM" for on-the-hour, "1 30 PM" for non-zero minutes.

/**
 * Format a Date for TTS: "7 PM" or "1 30 PM" (no colons).
 * @param {Date|string} date — Date object or ISO string
 * @returns {string}
 */
export function formatTimeForTTS(date) {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return '';
  const h = d.getHours();
  const m = d.getMinutes();
  const period = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 || 12;
  if (m === 0) return `${hour12} ${period}`;
  return `${hour12} ${m.toString().padStart(2, '0')} ${period}`;
}
