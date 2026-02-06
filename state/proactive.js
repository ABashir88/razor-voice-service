/**
 * Proactive Trigger Engine v2 — 14 triggers that make Razor speak first.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  CATEGORY A: TIME-BASED (fire once per day at target time)      │
 * │    #2  Morning Brief        7:30 AM ET                          │
 * │    #14 Daily Close          5:00 PM ET                          │
 * │                                                                  │
 * │  CATEGORY B: INTERVAL-BASED (check on tick, cooldown-gated)     │
 * │    #3  Meeting Approaching  10 min before (calendar check)      │
 * │    #4  Idle Too Long        90 min no calls                     │
 * │    #5  Below Pace           After 2 PM, behind target           │
 * │    #7  Deal Going Dark      5+ days no activity (4-hour check)  │
 * │                                                                  │
 * │  CATEGORY C: EVENT-BASED (fire on state transitions)            │
 * │    State Greeting           First ACTIVE entry of the day       │
 * │    Queued Alert Drain       On return to ACTIVE from away       │
 * │                                                                  │
 * │  CATEGORY D: GATEWAY-RELAYED (cron → gateway → onProactive)     │
 * │    #1  FIRE signal from PULSE                                   │
 * │    #6  Prospect email reply                                     │
 * │    #8  Resurrection signal                                      │
 * │    #9  Competitive intel                                        │
 * │    #10 Champion move                                            │
 * │    #11 Inbound lead                                             │
 * │    #12 Stage gate fail                                          │
 * │    #13 Pattern insight                                          │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * All spoken output goes through this.speak() → TTS → speaker.
 * All AI queries go through this.gateway.sendChat() → OpenClaw → response.
 */
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { log, logError } from '../lib/log.js';

const execAsync = promisify(execCb);

export class ProactiveEngine {
  constructor(stateMachine, config) {
    this.sm = stateMachine;
    this.config = config;
    this.speak = null;          // Set by main.js — async fn(text)
    this.gateway = null;        // Set by main.js — GatewayClient
    this.cooldowns = {};
    this.firedToday = new Set();
    this._intervals = [];
    this._running = false;
    this._upcomingMeetings = [];       // { start: Date, end: Date, title: string }
    this._alertedMeetings = new Set(); // Keys of meetings already prepped
    this._greetedToday = false;
    this._speaking = false;            // Prevent overlapping proactive speech
  }

  // ═══════════════════════════════════════════════════════════════════
  //  LIFECYCLE
  // ═══════════════════════════════════════════════════════════════════

  start() {
    if (this._running) return;
    this._running = true;

    // Main tick — every 60 seconds (first tick after 5s warmup)
    setTimeout(() => this._tick(), 5000);
    this._intervals.push(setInterval(() => this._tick(), 60 * 1000));

    // Calendar refresh — every 30 minutes
    this._intervals.push(setInterval(() => this._refreshCalendar(), 30 * 60 * 1000));

    // Deal dark check — every 4 hours
    this._intervals.push(setInterval(() => this._triggerDealDark(), 4 * 60 * 60 * 1000));

    // Ambient signal scan — every 15 minutes (Salesloft + Gmail + SFDC)
    this._intervals.push(setInterval(() => this._triggerAmbientScan(), 15 * 60 * 1000));

    // Gmail inbound check — every 10 minutes
    this._intervals.push(setInterval(() => this._triggerGmailCheck(), 10 * 60 * 1000));

    // Initial calendar fetch after 10s (let gateway connect first)
    setTimeout(() => this._refreshCalendar(), 10000);

    // Register state change listener for event-based triggers
    this.sm.onChange(async (newState, prevState) => {
      await this._onStateChange(newState, prevState);
    });

    // Midnight reset for daily triggers
    this._scheduleMidnightReset();

    log('🎯', 'Proactive engine v2 started — 14 triggers armed');
  }

  stop() {
    this._running = false;
    this._intervals.forEach(clearInterval);
    this._intervals = [];
  }

  // ═══════════════════════════════════════════════════════════════════
  //  CATEGORY D: GATEWAY RELAY (triggers #1, #6, #8-13)
  //
  //  Cron fires system events → AI responds → gateway broadcasts →
  //  voice service catches unmatched chat events → speaks them.
  // ═══════════════════════════════════════════════════════════════════

  async handleGatewayProactive(text) {
    if (!text || text === 'NO_REPLY' || text === 'HEARTBEAT_OK') return;

    const speakStates = ['WAITING', 'ACTIVE', 'FOCUS', 'CLOSING', 'DEBRIEF'];
    if (speakStates.includes(this.sm.current)) {
      log('📢', `Gateway relay → speaking (${text.length} chars)`);
      await this._safeSpeak(text);
    } else {
      this.sm.queueAlert({
        type: 'gateway',
        text: text.substring(0, 500),
        source: 'proactive',
      });
      log('📥', `Queued gateway alert (state: ${this.sm.current})`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  MAIN TICK (every 60 seconds)
  // ═══════════════════════════════════════════════════════════════════

  async _tick() {
    if (!this._ready()) return;

    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();
    const state = this.sm.current;

    try {
      // ── #2 Morning Brief (7:25–7:45) ──
      if (hour === 7 && minute >= 25 && minute <= 45) {
        await this._fireOnceDaily('morning-brief', ['WAITING', 'ACTIVE'], () =>
          this._askAI(
            `[VOICE PROACTIVE — MORNING BRIEF]\n` +
            `Run LOOP 2 BRIEF. Give Al his prioritized action list for today.\n` +
            `Format for SPOKEN delivery through a speaker — max 45 seconds.\n` +
            `Start with hottest signal, then meetings, then outbound queue.\n` +
            `End with: "Start at the top."`
          )
        );
      }

      // ── #14 Daily Close (4:55–5:15) ──
      if ((hour === 16 && minute >= 55) || (hour === 17 && minute <= 15)) {
        await this._fireOnceDaily('daily-close', ['ACTIVE', 'FOCUS', 'CLOSING'], () => {
          const s = this.sm.stats;
          return this._askAI(
            `[VOICE PROACTIVE — DAILY CLOSE]\n` +
            `Run LOOP 5 THINK. Al's stats today: ${s.callsToday} calls, ` +
            `${s.emailsToday} emails, ${s.meetingsBooked} meetings booked.\n` +
            `Score against targets, summarize key wins/misses, state tomorrow's #1 priority.\n` +
            `Format for SPOKEN delivery — max 30 seconds. End with: "Anything I missed?"`
          );
        });
      }

      // ── #3 Meeting Approaching ──
      await this._triggerMeetingPrep(now, state);

      // ── #4 Idle Nudge ──
      await this._triggerIdleNudge(now, state);

      // ── #5 Below Pace ──
      await this._triggerPaceAlert(now, state);

    } catch (err) {
      log('⚠️', `Tick error: ${err.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  CATEGORY A: TIME-BASED TRIGGERS
  // ═══════════════════════════════════════════════════════════════════

  async _fireOnceDaily(id, allowedStates, fn) {
    if (this.firedToday.has(id)) return;
    if (!allowedStates.includes(this.sm.current)) return;

    this.firedToday.add(id);
    log('⏰', `Firing: ${id}`);

    try {
      const response = await fn();
      if (response) await this._safeSpeak(response);
    } catch (err) {
      logError(`Trigger ${id} failed`, err);
      this.firedToday.delete(id); // Allow retry
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  CATEGORY B: INTERVAL-BASED TRIGGERS
  // ═══════════════════════════════════════════════════════════════════

  // ── #3: Meeting Approaching (10 min before) ──

  async _triggerMeetingPrep(now, state) {
    if (!['WAITING', 'ACTIVE', 'FOCUS', 'DEBRIEF', 'CLOSING'].includes(state)) return;

    const prepMinutes = this.config.proactive?.meetingPrepMinutes || 10;

    for (const meeting of this._upcomingMeetings) {
      const minutesUntil = (meeting.start - now) / 60000;
      const key = `${meeting.start.getHours()}:${String(meeting.start.getMinutes()).padStart(2, '0')}-${meeting.title}`;

      if (minutesUntil > 0 && minutesUntil <= prepMinutes + 2 && !this._alertedMeetings.has(key)) {
        this._alertedMeetings.add(key);
        log('📅', `Meeting prep: "${meeting.title}" in ${Math.round(minutesUntil)} min`);

        try {
          const response = await this._askAI(
            `[VOICE PROACTIVE — MEETING PREP]\n` +
            `Meeting "${meeting.title}" starts in ${Math.round(minutesUntil)} minutes.\n` +
            `Run LOOP 3 PREP. Who's on the call, what's the context, what should Al focus on?\n` +
            `If you can identify attendees, check their accounts and history.\n` +
            `Format for SPOKEN delivery — max 30 seconds. Be specific and actionable.`
          );
          if (response) await this._safeSpeak(response);
        } catch (err) {
          logError('Meeting prep failed', err);
        }
      }
    }
  }

  // ── #4: Idle Too Long (90 min no calls) ──

  async _triggerIdleNudge(now, state) {
    if (state !== 'ACTIVE') return;
    if (this._onCooldown('idle', 60)) return;

    const lastCall = this.sm.stats.lastCallTime;
    const lastActivity = this.sm.stats.lastActivity;
    const reference = lastCall || lastActivity || this.sm.enteredAt;
    if (!reference) return;

    const minutesSince = (now - reference) / 60000;
    const threshold = this.config.proactive?.silenceAlertMinutes || 90;

    if (minutesSince >= threshold) {
      this._setCooldown('idle');
      log('⏰', `Idle nudge: ${Math.floor(minutesSince)} min since last activity`);

      try {
        const response = await this._askAI(
          `[VOICE PROACTIVE — IDLE NUDGE]\n` +
          `Al hasn't made a call in ${Math.floor(minutesSince)} minutes.\n` +
          `Give him a quick nudge with his next target. Name, number, one-line script.\n` +
          `Keep it brief — max 3 sentences. End with "Go."`
        );
        if (response) await this._safeSpeak(response);
      } catch (err) {
        logError('Idle nudge failed', err);
      }
    }
  }

  // ── #5: Below Pace (behind call target after 2 PM) ──

  async _triggerPaceAlert(now, state) {
    if (state !== 'ACTIVE') return;
    if (this._onCooldown('pace', 120)) return;

    const hour = now.getHours();
    if (hour < (this.config.proactive?.paceCheckAfterHour || 14)) return;

    const target = this.config.targets?.dailyCalls || 20;
    const hoursWorked = Math.max(1, hour - 8);
    const expectedPace = Math.floor(target * (hoursWorked / 9));
    const actual = this.sm.stats.callsToday;

    if (actual < expectedPace * 0.7) {
      this._setCooldown('pace');
      log('📊', `Pace alert: ${actual} calls vs ${expectedPace} expected`);

      try {
        const response = await this._askAI(
          `[VOICE PROACTIVE — PACE ALERT]\n` +
          `It's ${hour}:${String(now.getMinutes()).padStart(2, '0')} and Al has ` +
          `${actual} calls today. Target pace: ${expectedPace} by now (daily target: ${target}).\n` +
          `He needs to pick it up. Give him the next 3 targets with numbers and scripts.\n` +
          `Be direct and motivating — max 30 seconds spoken.`
        );
        if (response) await this._safeSpeak(response);
      } catch (err) {
        logError('Pace alert failed', err);
      }
    }
  }

  // ── #7: Deal Going Dark (5+ days no activity) ──

  async _triggerDealDark() {
    if (this.sm.current !== 'ACTIVE') return;
    if (this._onCooldown('deal-dark', 240)) return;
    if (!this._ready()) return;

    this._setCooldown('deal-dark');
    log('⚠️', 'Checking for dark deals...');

    try {
      const response = await this._askAI(
        `[VOICE PROACTIVE — DEAL DARK CHECK]\n` +
        `Check active pipeline for deals going dark (5+ days no activity).\n` +
        `Review accounts in MEMORY.md and knowledge/accounts/.\n` +
        `If any deal is stalling, alert Al with: deal name, days silent, rescue play.\n` +
        `If all deals are active, respond with just NO_REPLY.\n` +
        `Format for SPOKEN delivery — max 20 seconds per deal.`
      );
      if (response) await this._safeSpeak(response);
    } catch (err) {
      logError('Deal dark check failed', err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  CATEGORY C: EVENT-BASED TRIGGERS
  // ═══════════════════════════════════════════════════════════════════

  async _onStateChange(newState, prevState) {
    // ── State greeting on ACTIVE entry ──
    if (newState === 'ACTIVE' && !this._greetedToday) {
      this._greetedToday = true;

      // Wait for gateway connection if needed
      await this._waitForGateway(15000);
      if (!this._ready()) return;

      log('👋', `State greeting (${prevState} → ACTIVE)`);

      try {
        const s = this.sm.stats;
        const queued = this.sm.queuedAlerts.length;
        const hour = new Date().getHours();
        const timeOfDay = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';

        const response = await this._askAI(
          `[VOICE PROACTIVE — STATE GREETING]\n` +
          `Al just went ACTIVE (good ${timeOfDay}). Previous state: ${prevState || 'startup'}.\n` +
          `Stats today: ${s.callsToday} calls, ${s.emailsToday} emails, ${s.meetingsBooked} meetings.\n` +
          `${queued > 0 ? `${queued} alerts queued while away. ` : ''}` +
          `Give a quick spoken greeting — what's the #1 thing he should do RIGHT NOW?\n` +
          `Keep it to 15 seconds. Be direct. No pleasantries.`
        );
        if (response) await this._safeSpeak(response);

        // Drain queued alerts if any
        if (queued > 0) {
          const alerts = this.sm.drainAlerts();
          const summary = alerts
            .slice(-5) // Last 5 most recent
            .map(a => a.text)
            .filter(Boolean)
            .join('\n');
          if (summary) {
            const qResponse = await this._askAI(
              `[VOICE PROACTIVE — QUEUED ALERTS]\n` +
              `These alerts fired while Al was away. Summarize the important ones.\n` +
              `Format for SPOKEN delivery — max 30 seconds:\n\n${summary}`
            );
            if (qResponse) await this._safeSpeak(qResponse);
          }
        }
      } catch (err) {
        logError('State greeting failed', err);
      }
    }

    // ── Auto-close: if CLOSING for 30+ min, transition to MONITORING ──
    if (newState === 'CLOSING') {
      setTimeout(async () => {
        if (this.sm.current === 'CLOSING' && this.sm.minutesInState >= 28) {
          log('🌙', 'Auto-transitioning to MONITORING');
          await this.sm.transition('MONITORING');
        }
      }, 30 * 60 * 1000);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  CALENDAR
  // ═══════════════════════════════════════════════════════════════════

  async _refreshCalendar() {
    try {
      const today = new Date();
      const todayStr = today.toISOString().split('T')[0];
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowStr = tomorrow.toISOString().split('T')[0];

      const { stdout } = await execAsync(
        `/opt/homebrew/bin/gog calendar events primary --from ${todayStr} --to ${tomorrowStr} --plain`,
        { timeout: 15000, env: { ...process.env, HOME: process.env.HOME || '/Users/alrazibashir' } }
      );

      this._upcomingMeetings = this._parseCalendar(stdout, today);
      if (this._upcomingMeetings.length > 0) {
        log('📅', `Calendar: ${this._upcomingMeetings.length} meetings today`);
      }
    } catch (err) {
      // Best-effort — don't spam logs
      if (this._upcomingMeetings.length === 0) {
        log('⚠️', `Calendar: ${(err.message || '').substring(0, 60)}`);
      }
    }
  }

  _parseCalendar(text, refDate) {
    const meetings = [];
    if (!text) return meetings;

    for (const line of text.split('\n')) {
      if (!line.trim()) continue;

      // Match time ranges: "11:00 - 11:30", "11:00 AM – 12:00 PM", "09:00-10:00"
      const m = line.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?\s*[-–—]\s*(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
      if (!m) continue;

      let sh = parseInt(m[1]), sm = parseInt(m[2]);
      let eh = parseInt(m[4]), em = parseInt(m[5]);

      // AM/PM conversion
      if (m[3]?.toUpperCase() === 'PM' && sh < 12) sh += 12;
      if (m[3]?.toUpperCase() === 'AM' && sh === 12) sh = 0;
      if (m[6]?.toUpperCase() === 'PM' && eh < 12) eh += 12;
      if (m[6]?.toUpperCase() === 'AM' && eh === 12) eh = 0;

      // Extract title — everything after the time pattern, clean up separators
      const afterTime = line.substring(line.indexOf(m[0]) + m[0].length);
      const title = afterTime.replace(/^\s*[|│·:]\s*/, '').trim() || 'Meeting';

      const start = new Date(refDate);
      start.setHours(sh, sm, 0, 0);
      const end = new Date(refDate);
      end.setHours(eh, em, 0, 0);

      meetings.push({ start, end, title });
    }

    return meetings.sort((a, b) => a.start - b.start);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  AMBIENT MONITORING (Salesloft + Gmail + SFDC)
  //
  //  These run independently of cron. The voice service asks the AI to
  //  quick-check data sources. Only speaks if something urgent found.
  //  Skips if Al is actively talking (last activity < 5 min ago).
  // ═══════════════════════════════════════════════════════════════════

  // ── Real-time signal scan (every 15 min, business hours) ──

  async _triggerAmbientScan() {
    if (!['ACTIVE', 'WAITING'].includes(this.sm.current)) return;
    if (!this._ready()) return;
    if (this._onCooldown('ambient', 14)) return;

    // Skip if Al is actively talking (conversation in progress)
    const lastActivity = this.sm.stats.lastActivity;
    if (lastActivity && (Date.now() - lastActivity) < 2 * 60 * 1000) {
      return; // He's in a voice conversation — don't interrupt with background scan
    }

    this._setCooldown('ambient');
    log('🔍', 'Ambient signal scan...');

    try {
      const response = await this._askAI(
        `[VOICE PROACTIVE — AMBIENT SCAN]\n` +
        `Quick 15-minute signal check. This is a background scan — only interrupt Al if it matters.\n\n` +
        `1. Hit Salesloft API: GET /v2/activities/emails?sort_by=updated_at&sort_direction=desc&per_page=25\n` +
        `   Auth: Bearer $SALESLOFT_API_KEY. Filter by owner (user_id 89440).\n` +
        `   Look for: replies, clicks, multi-opens in the last 15 minutes.\n\n` +
        `2. Check Gmail: gog gmail search 'to:alrazi@telnyx.com category:primary newer_than:15m' --max 10 --plain\n` +
        `   Look for: direct replies from prospects or customers.\n\n` +
        `3. Cross-reference: Anyone engaged in Salesloft who ALSO emailed directly?\n\n` +
        `CLASSIFICATION:\n` +
        `- FIRE (reply, click+Tier1, multi-person, direct email from pipeline contact) → SPEAK with CALL NOW\n` +
        `- HOT (click, 3+ opens) → SPEAK with brief alert\n` +
        `- Everything else → respond with just NO_REPLY\n\n` +
        `Format for SPOKEN delivery — max 20 seconds. Name, what they did, what Al should do, number if available.`
      );
      if (response) {
        log('🔥', 'Ambient scan found signal!');
        await this._safeSpeak(response);
      }
    } catch (err) {
      logError('Ambient scan failed', err);
    }
  }

  // ── Gmail inbound check (every 10 min) ──

  async _triggerGmailCheck() {
    if (!['ACTIVE', 'WAITING'].includes(this.sm.current)) return;
    if (!this._ready()) return;
    if (this._onCooldown('gmail', 9)) return;

    // Skip if recent voice activity
    const lastActivity = this.sm.stats.lastActivity;
    if (lastActivity && (Date.now() - lastActivity) < 2 * 60 * 1000) return;

    this._setCooldown('gmail');

    try {
      // Direct Gmail check via gog CLI — faster than asking the AI
      const { stdout } = await execAsync(
        `/opt/homebrew/bin/gog gmail search 'to:alrazi@telnyx.com category:primary ` +
        `-from:no-reply -from:noreply -from:marketo -from:sales@telnyx.com ` +
        `-from:notifications -from:fellow.app -from:google.com -from:slack.com ` +
        `-from:salesforce.com -from:salesloft.com newer_than:15m' --max 5 --plain`,
        { timeout: 15000, env: { ...process.env, HOME: process.env.HOME || '/Users/alrazibashir' } }
      );

      // If gog returned results, there might be inbound emails
      const lines = (stdout || '').trim().split('\n').filter(l => l.trim());
      if (lines.length > 0 && !stdout.includes('No messages found')) {
        log('📧', `Gmail: ${lines.length} new emails detected`);

        // Ask the AI to classify and script the response
        const response = await this._askAI(
          `[VOICE PROACTIVE — GMAIL ALERT]\n` +
          `New email(s) detected in the last 15 minutes:\n\n${stdout.substring(0, 2000)}\n\n` +
          `Is this from a real prospect, customer, or colleague about a deal?\n` +
          `If YES: Alert Al with sender, subject, and recommended action. Format for SPOKEN delivery — max 15 seconds.\n` +
          `If it's automated, internal noise, or irrelevant: respond with just NO_REPLY.`
        );
        if (response) {
          log('📧', 'Gmail alert triggered');
          await this._safeSpeak(response);
        }
      }
    } catch (err) {
      // Gmail check is best-effort
      if (!err.message?.includes('timeout') && !err.message?.includes('No messages')) {
        log('⚠️', `Gmail check: ${(err.message || '').substring(0, 60)}`);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  UTILITIES
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Send a prompt to the AI via gateway and return the response.
   * Returns null if no meaningful response.
   */
  async _askAI(prompt) {
    const response = await this.gateway.sendChat(prompt);
    if (!response || response === 'NO_REPLY' || response === 'HEARTBEAT_OK') return null;
    return response;
  }

  /**
   * Speak with mutual exclusion — prevents overlapping proactive speech.
   */
  async _safeSpeak(text) {
    if (this._speaking || !text) return;
    this._speaking = true;
    try {
      await this.speak(text);
    } finally {
      this._speaking = false;
    }
  }

  _ready() {
    return this._running && this.speak && this.gateway?.isConnected;
  }

  async _waitForGateway(timeoutMs) {
    const start = Date.now();
    while (!this.gateway?.isConnected && Date.now() - start < timeoutMs) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  _onCooldown(trigger, minutes) {
    const last = this.cooldowns[trigger];
    if (!last) return false;
    return (Date.now() - last) < minutes * 60 * 1000;
  }

  _setCooldown(trigger) {
    this.cooldowns[trigger] = Date.now();
  }

  _scheduleMidnightReset() {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);

    setTimeout(() => {
      this.firedToday.clear();
      this._alertedMeetings.clear();
      this._greetedToday = false;
      log('🌅', 'Midnight reset — daily triggers cleared');
      this._scheduleMidnightReset();
    }, midnight - now);
  }
}
