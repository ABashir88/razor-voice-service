/**
 * Shared logger — timestamps + emoji prefix.
 * Writes to stdout (captured by LaunchAgent to /tmp/razor-voice.log).
 */
export function log(emoji, msg) {
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false, timeZone: 'America/New_York' });
  console.log(`${ts} ${emoji} ${msg}`);
}

export function logError(msg, err) {
  log('❌', `${msg}: ${err?.message || err}`);
}
