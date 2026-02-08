// src/index.js — Razor Voice Service Entry Point
//
// Wires together: Voice Pipeline → Brain → Memory → Integrations
//
// Flow:
//   1. User says "Razor" → wake word triggers LISTENING
//   2. Speech captured → PROCESSING → sent to Brain via WebSocket
//   3. Brain responds → text spoken via TTS, actions dispatched
//   4. Memory records interaction, learns from outcomes
//   5. Integrations service brain-suggested actions (CRM, email, search)

import VoicePipeline from './pipeline/voice-pipeline.js';
import { MemoryAgent } from './memory/index.js';
import { IntegrationManager } from './integrations/index.js';
import { getBrainConnector } from './brain/connector.js';
import { getStateMachine, States } from './state/stateMachine.js';
import makeLogger from './utils/logger.js';

const log = makeLogger('Main');
const sm = getStateMachine();

// ── Component Instances ──
const pipeline = new VoicePipeline();
const memory = new MemoryAgent();
const integrations = new IntegrationManager();
const brain = getBrainConnector();

// ── Track current conversation ──
let conversationActive = false;

// ══════════════════════════════════════════════════════════════════════════
//  ACTION DISPATCHER
//  When the brain suggests an action, we route it to the right integration.
// ══════════════════════════════════════════════════════════════════════════

// Actions that fetch data the user asked about — must run BEFORE speaking
// so results can be fed back to the brain for a natural response.
const DATA_FETCH_ACTIONS = new Set([
  'search_contact', 'lookup_contact', 'get_context',
  'check_calendar', 'get_schedule', 'get_calendar',
  'check_email', 'search_email',
  'research', 'search_web', 'search',
  'account_brief', 'lookup_account',
  'meeting_prep',
  'check_time', 'get_time',
  'get_pipeline', 'check_pipeline',
  'create_reminder', 'set_reminder', 'remind',
  'log_call', 'log_interaction', 'log_activity', 'log',
  // Fellow actions
  'get_action_items', 'get_tasks', 'my_action_items', 'action_items',
  'get_overdue_items', 'overdue_tasks',
  'last_meeting', 'get_last_meeting', 'how_did_my_call_go', 'get_activity_stats',
  'coach_me', 'coaching_insights', 'get_coaching',
  'get_talk_ratio', 'talk_ratio',
  'get_today_meetings', 'todays_meetings', 'meetings_today',
  'search_meetings', 'meeting_summary', 'get_meeting_recap',
  'get_transcript', 'get_call_transcript', 'get_recent_call_transcript', 'transcript',
  'recent_recordings', 'get_recordings', 'recordings_this_week', 'get_recent_call_recording',
  'get_recent_notes', 'notes_last_week',
  'get_meeting_actions', 'meeting_action_items',
  // Salesloft actions
  'get_hot_leads', 'hot_leads',
  'get_email_opens', 'email_opens', 'who_opened',
  'get_email_clicks', 'email_clicks', 'who_clicked',
  'get_replies', 'who_replied',
  'get_my_cadences', 'my_cadences', 'cadences',
  'activity_stats',
  'get_biggest_deal', 'biggest_deal', 'largest_deal',
]);

async function dispatchAction(action) {
  const type = action.action || action.type;
  const params = action.params || {};

  log.info(`Dispatching action: ${type}`);

  try {
    switch (type) {
      case 'search_contact':
      case 'lookup_contact':
        return await integrations.getContactContext(params.name || params.query);

      case 'get_context': {
        // Route by params.type: contact, account, calendar, email, deal
        const ctxType = (params.type || '').toLowerCase();
        if (ctxType === 'account' || ctxType === 'company') {
          return await integrations.getFullAccountBrief(params.name || params.accountName || params.query);
        }
        if (ctxType === 'calendar' || ctxType === 'schedule') {
          return await integrations.getUpcomingSchedule(params.days || 7);
        }
        if (ctxType === 'email' || ctxType === 'emails') {
          if (integrations.google) {
            const q = params.query || params.name || '';
            return await integrations.google.getRecentEmails(q, params.max || 10);
          }
          log.warn('Google not available for email search');
          return null;
        }
        // Default: contact lookup
        return await integrations.getContactContext(params.name || params.id || params.query);
      }

      case 'log_call':
      case 'log_interaction':
      case 'log_activity':
      case 'log': {
        const contactName = params.contactName || params.contact || params.name;
        const logType = params.type || 'call';
        try {
          await integrations.logInteraction(params.contactId, params);
        } catch (err) {
          log.warn('Failed to log interaction:', err.message);
        }
        return `Logged your ${logType}${contactName ? ' with ' + contactName : ''}.`;
      }

      case 'send_email':
      case 'send_follow_up':
        return await integrations.sendFollowUp(params);

      case 'draft_email':
        return await integrations.sendFollowUp({ ...params, draft: true });

      case 'research':
      case 'search_web':
      case 'search':
      case 'web_search':
        return await integrations.research(params.query || params.topic);

      case 'get_schedule':
      case 'get_calendar':
      case 'check_calendar':
        return await integrations.getUpcomingSchedule(params.days || 7);

      case 'check_email':
      case 'search_email':
        if (integrations.google) {
          return await integrations.google.getRecentEmails(params.query || '', params.max || 10);
        }
        log.warn('Google not available for email search');
        return null;

      case 'account_brief':
      case 'lookup_account':
        return await integrations.getFullAccountBrief(params.accountName || params.name);

      case 'meeting_prep':
        return await integrations.getMeetingPrep(params.contactName, params.accountName);

      case 'schedule_meeting':
      case 'create_event':
        if (integrations.google) {
          return await integrations.google.createEvent({
            summary: params.summary || params.title || 'Meeting',
            start: params.start,
            end: params.end,
            description: params.description,
            location: params.location,
            attendees: params.attendees || params.participants,
          });
        }
        log.warn('Google not available for event creation');
        return null;

      case 'check_time':
      case 'get_time': {
        const now = new Date();
        const time = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        const day = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
        return { time, day, text: `It's ${time}, ${day}.` };
      }

      case 'get_pipeline':
      case 'pipeline':
      case 'check_pipeline':
        if (integrations.salesforce) {
          const pipeline = await integrations.salesforce.getPipeline();
          return pipeline.text;
        }
        log.warn('No CRM available for pipeline check');
        return null;

      case 'create_reminder':
      case 'set_reminder':
      case 'remind': {
        const reminderTask = params.task || params.message || params.text || 'follow up';
        const reminderContact = params.contact || params.name;
        const reminderDate = params.date || params.when;
        // Try to create in calendar or Salesforce
        if (integrations.google) {
          const startTime = params.time || params.when || new Date(Date.now() + 3600000).toISOString();
          try {
            await integrations.google.createEvent({
              summary: params.message || params.text || `Reminder: ${reminderTask}`,
              start: startTime,
              end: startTime,
              description: `Reminder: ${reminderTask}${reminderContact ? ' with ' + reminderContact : ''}`,
            });
          } catch (err) {
            log.warn('Failed to create reminder event:', err.message);
          }
        } else if (integrations.salesforce) {
          try {
            await integrations.salesforce.createTask({
              Subject: params.message || params.text || `Reminder: ${reminderTask}`,
              ActivityDate: params.date || new Date().toISOString().slice(0, 10),
            });
          } catch (err) {
            log.warn('Failed to create reminder task:', err.message);
          }
        }
        return `Got it. I'll remind you to ${reminderTask}${reminderContact ? ' with ' + reminderContact : ''}${reminderDate ? ' on ' + reminderDate : ''}.`;
      }

      case 'create_task':
        if (integrations.salesforce) {
          return await integrations.salesforce.createTask(params);
        }
        log.warn('Salesforce not available for task creation');
        return null;

      case 'update_opportunity':
      case 'update_crm':
        if (integrations.salesforce) {
          return await integrations.salesforce.updateOpportunity(
            params.id || params.dealId,
            params.fields || { [params.field]: params.value },
          );
        }
        log.warn('Salesforce not available for CRM update');
        return null;


      // ═══════════════════════════════════════════════════════════════════════

      // ═══════════════════════════════════════════════════════════════════════
      // SALESLOFT — Email Engagement, Cadences, Activity Stats
      // ═══════════════════════════════════════════════════════════════════════

      case 'get_hot_leads':
      case 'hot_leads': {
        if (integrations.salesloft) {
          const leads = await integrations.salesloft.getHotLeads();
          if (!leads?.length) return "No hot leads right now.";
          const top3 = leads.slice(0, 3).map(l => l.name || l.email).join(", ");
          return `${leads.length} hot lead${leads.length > 1 ? "s" : ""}: ${top3}.`;
        }
        return "Salesloft not connected.";
      }

      case 'get_email_opens':
      case 'email_opens':
      case 'who_opened': {
        if (integrations.salesloft) {
          const opens = await integrations.salesloft.getEmailOpens();
          if (!opens?.length) return "No email opens recently.";
          const top3 = opens.slice(0, 3).map(o => o.name || o.email).join(", ");
          return `${opens.length} open${opens.length > 1 ? "s" : ""}: ${top3}.`;
        }
        return "Salesloft not connected.";
      }

      case 'get_email_clicks':
      case 'email_clicks':
      case 'who_clicked': {
        if (integrations.salesloft) {
          const clicks = await integrations.salesloft.getEmailClicks();
          if (!clicks?.length) return "No email clicks recently.";
          const top3 = clicks.slice(0, 3).map(c => c.name || c.email).join(", ");
          return `${clicks.length} click${clicks.length > 1 ? "s" : ""}: ${top3}.`;
        }
        return "Salesloft not connected.";
      }

      case 'get_replies':
      case 'who_replied': {
        if (integrations.salesloft) {
          const replies = await integrations.salesloft.getReplies();
          if (!replies?.length) return "No replies recently.";
          const top3 = replies.slice(0, 3).map(r => r.name || r.email).join(", ");
          return `${replies.length} repl${replies.length > 1 ? "ies" : "y"}: ${top3}.`;
        }
        return "Salesloft not connected.";
      }

      case 'get_my_cadences':
      case 'my_cadences':
      case 'cadences': {
        if (integrations.salesloft) {
          const cadences = await integrations.salesloft.getMyCadences();
          if (!cadences?.length) return "No active cadences.";
          const top3 = cadences.slice(0, 3).map(c => c.name).join(", ");
          return `${cadences.length} cadence${cadences.length > 1 ? "s" : ""}: ${top3}.`;
        }
        return "Salesloft not connected.";
      }

      case 'get_activity_stats':
      case 'activity_stats': {
        if (integrations.salesloft) {
          const stats = await integrations.salesloft.getActivityStats();
          if (!stats) return "Could not get activity stats.";
          return `Today: ${stats.calls || 0} calls, ${stats.emails || 0} emails.`;
        }
        return "Salesloft not connected.";
      }

      case 'get_biggest_deal':
      case 'biggest_deal':
      case 'largest_deal': {
        if (integrations.salesforce) {
          const opps = await integrations.salesforce.queryOpportunities({ orderBy: "Amount DESC", limit: 1 });
          if (!opps?.length) return "No open deals found.";
          const deal = opps[0];
          const amt = deal.Amount ? `$${(deal.Amount/1000).toFixed(0)}k` : "";
          const name = (deal.Name || "").split(" - ")[0] || deal.Account?.Name || "Unknown";
          return `Your biggest open deal is ${name} at ${amt || "unknown amount"}.`;
        }
        return "Salesforce not connected.";
      }

      // FELLOW — Action Items, Meetings, Coaching, Transcripts
      // ═══════════════════════════════════════════════════════════════════════

      case 'get_action_items':
      case 'get_tasks':
      case 'my_action_items':
      case 'action_items': {
        if (integrations.fellow) {
          const items = await integrations.fellow.getMyActionItems();
          if (!items?.length) return "No open action items right now.";
          const top3 = items.slice(0, 3).map(i => i.title || i.text).join(". ");
          return `You have ${items.length} action item${items.length > 1 ? "s" : ""}. ${top3}.`;
        }
        return "Fellow not connected.";
      }

      case 'get_overdue_items':
      case 'overdue_tasks': {
        if (integrations.fellow) {
          const items = await integrations.fellow.getOverdueItems();
          if (!items?.length) return "Nothing overdue. You are all caught up.";
          const top3 = items.slice(0, 3).map(i => i.title || i.text).join(". ");
          return `${items.length} overdue item${items.length > 1 ? "s" : ""}. ${top3}.`;
        }
        return "Fellow not connected.";
      }

      case 'last_meeting':
      case 'get_last_meeting':
      case 'how_did_my_call_go':
      case 'get_activity_stats': {
        if (integrations.fellow) {
          const summary = await integrations.fellow.getLastMeetingSummary();
          if (!summary) return "No recent meetings found.";
          return summary.summary || `Last meeting: ${summary.title}. ${summary.duration || ""}`;
        }
        return "Fellow not connected.";
      }

      case 'coach_me':
      case 'coaching_insights':
      case 'get_coaching': {
        if (integrations.fellow) {
          const insights = await integrations.fellow.getCoachingInsights();
          if (!insights) return "No coaching data available yet.";
          return insights.summary || insights;
        }
        return "Fellow not connected.";
      }

      case 'get_talk_ratio':
      case 'talk_ratio': {
        if (integrations.fellow) {
          const rec = await integrations.fellow.getLastRecording();
          if (!rec) return "No recent recordings to analyze.";
          const analytics = await integrations.fellow.getTranscriptAnalytics(rec.id);
          if (!analytics) return "Could not get talk ratio.";
          return `Your talk ratio was ${analytics.userTalkRatio || "unknown"}. ${analytics.summary || ""}`;
        }
        return "Fellow not connected.";
      }

      case 'get_today_meetings':
      case 'todays_meetings':
      case 'meetings_today': {
        if (integrations.fellow) {
          const meetings = await integrations.fellow.getTodaysMeetings();
          if (!meetings?.length) return "No meetings scheduled for today.";
          const names = meetings.slice(0, 3).map(m => m.title).join(", ");
          return `${meetings.length} meeting${meetings.length > 1 ? "s" : ""} today: ${names}.`;
        }
        return "Fellow not connected.";
      }

      case 'search_meetings':
      case 'meeting_summary':
      case 'get_meeting_recap': {
        if (integrations.fellow) {
          const query = params.query || params.company || params.name;
          if (!query) return "Who or what company should I search for?";
          const summary = await integrations.fellow.getMeetingSummaryBySearch(query);
          if (!summary) return `No meetings found for ${query}.`;
          return summary.summary || `Found meeting: ${summary.title}.`;
        }
        return "Fellow not connected.";
      }

      case 'get_transcript':
      case 'get_call_transcript':
      case 'get_recent_call_transcript':
      case 'transcript': {
        if (integrations.fellow) {
          const rec = await integrations.fellow.getLastRecording();
          if (!rec) return "No recent recordings found.";
          const text = await integrations.fellow.getTranscriptText(rec.id);
          if (!text) return "Transcript not available.";
          return text.slice(0, 300) + (text.length > 300 ? "..." : "");
        }
        return "Fellow not connected.";
      }

      case 'recent_recordings':
      case 'get_recent_call_recording':
      case 'get_recordings':
      case 'recordings_this_week': {
        if (integrations.fellow) {
          const recs = await integrations.fellow.getRecentRecordings(7);
          if (!recs?.length) return "No recordings in the last week.";
          const names = recs.slice(0, 3).map(r => r.title || "Untitled").join(", ");
          return `${recs.length} recording${recs.length > 1 ? "s" : ""} this week: ${names}.`;
        }
        return "Fellow not connected.";
      }

      case 'get_recent_notes':
      case 'notes_last_week': {
        if (integrations.fellow) {
          const notes = await integrations.fellow.getRecentNotes(7);
          if (!notes?.length) return "No meeting notes from last week.";
          const names = notes.slice(0, 3).map(n => n.title).join(", ");
          return `${notes.length} meeting note${notes.length > 1 ? "s" : ""}: ${names}.`;
        }
        return "Fellow not connected.";
      }

      case 'get_meeting_actions':
      case 'meeting_action_items': {
        if (integrations.fellow) {
          const query = params.query || params.company || params.name;
          const notes = query ? await integrations.fellow.searchNotes(query) : await integrations.fellow.getRecentNotes(7);
          if (!notes?.length) return query ? `No meetings found for ${query}.` : "No recent meetings.";
          const items = await integrations.fellow.getActionItemsForMeeting(notes[0].id);
          if (!items?.length) return `No action items from ${notes[0].title}.`;
          const top3 = items.slice(0, 3).map(i => i.title || i.text).join(". ");
          return `Action items from ${notes[0].title}: ${top3}.`;
        }
        return "Fellow not connected.";
      }

      default:
        log.warn(`Unknown action type: ${type} | params: ${JSON.stringify(params)}`);
        return { text: "I can't do that yet." };
    }
  } catch (err) {
    log.error(`Action ${type} failed:`, err.message);
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  COMMAND HANDLER
//  Voice pipeline emits 'command' when user speech is captured.
//  We send it to the brain, speak the response, and dispatch actions.
//
//  For data-fetching actions (calendar, contacts, research), we dispatch
//  FIRST, feed results back to the brain, then speak the enriched response.
// ══════════════════════════════════════════════════════════════════════════

async function handleCommand({ text, source }) {
  log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log.info(`  📝 "${text}"`);
  log.info(`  Source: ${source}`);
  log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Start conversation tracking if not active
  if (!conversationActive) {
    conversationActive = true;
    await memory.startConversation({
      topic: 'voice_interaction',
    });
  }

  // Record user turn in memory
  memory.addTurn('user', text, { source });

  // ── If brain is connected, use it ──
  if (brain.connected) {
    try {
      const response = await brain.process(text, {
        source,
        memoryContext: memory.getContext(),
      });

      let speakText = extractSpeakableText(response.text);
      log.info(`Brain response (${response.latency_ms}ms): "${speakText.slice(0, 80)}${speakText.length > 80 ? '...' : ''}"`);

      // ── Separate data-fetching actions from fire-and-forget ──
      // Brain may use "action" or "type" field — normalize to "action"
      const allActions = (response.actions || []).map(a => ({
        ...a,
        action: a.action || a.type,
      }));
      if (allActions.length > 0) {
        log.info(`Brain actions: ${JSON.stringify(allActions)}`);
      }
      const dataActions = allActions.filter(a => DATA_FETCH_ACTIONS.has(a.action));
      const bgActions = allActions.filter(a => !DATA_FETCH_ACTIONS.has(a.action));

      // ── Dispatch data-fetching actions and format results directly ──
      // When data actions exist, the brain's text is filler ("Checking calendar.")
      // We ALWAYS replace it with formatted data. If data fetch fails, use a
      // short fallback — never speak the brain's filler phrase.
      if (dataActions.length > 0) {
        log.info(`Fetching data for ${dataActions.length} action(s)...`);

        const results = await Promise.all(
          dataActions.map(async (a) => {
            const result = await dispatchAction(a);
            return { action: a.action, params: a.params, result };
          }),
        );

        const fetched = results.filter(r => r.result != null);
        if (fetched.length > 0) {
          const dataSummary = fetched
            .map(r => formatDataForSpeech(r.action, r.result))
            .filter(Boolean)
            .join(' ');
          if (dataSummary) {
            speakText = dataSummary;
            log.info(`Data response: "${speakText.slice(0, 80)}${speakText.length > 80 ? '...' : ''}"`);
          } else {
            // Data returned but formatter couldn't summarize — don't speak filler
            speakText = 'Got the data but nothing to report.';
          }
        } else {
          // All data fetches returned null — don't speak brain filler
          speakText = "Couldn't pull that up right now.";
        }
      }

      // Dispatch fire-and-forget actions BEFORE TTS check — always execute
      if (bgActions.length > 0) {
        log.info(`Dispatching ${bgActions.length} background action(s)...`);
        dispatchBgActions(bgActions);
      }

      // Clean before TTS — strip artifacts, skip placeholder responses
      speakText = cleanForTTS(speakText);
      if (!speakText) {
        log.info('Skipping TTS — empty or placeholder response after cleaning');
        sm.transition(States.LISTENING, 'empty_response');
        return;
      }

      // Record brain turn in memory
      memory.addTurn('assistant', speakText, {
        intent: response.intent,
        entities: response.entities,
      });

      // Speak the response
      const pace = determinePace(response);
      await pipeline.speak(speakText, { pace });

      // If the brain detected entities, update semantic memory
      if (response.entities?.length > 0) {
        updateSemanticMemory(response.entities);
      }

      return;
    } catch (err) {
      log.error('Brain processing failed:', err.message);
      // Fall through to offline mode
    }
  }

  // ── Offline fallback: echo with apology ──
  log.warn('Brain unavailable — using offline fallback');
  const fallback = `I heard: ${text}. But my brain service isn't connected right now. I'll remember this for when I'm back online.`;
  memory.addTurn('assistant', fallback, { offline: true });
  await pipeline.speak(fallback, { pace: 'calm' });
}

// Responses that should never be spoken — brain sometimes returns these as filler
const SKIP_RESPONSES = new Set(['.', '..', '...', '', ' ', '""', "''", 'null', 'undefined']);

// ── Extract clean speakable text from brain response ──
// Guards against JSON/markdown leaking through to TTS
function extractSpeakableText(rawText) {
  if (!rawText) return '';
  let text = rawText;

  // Strip markdown code blocks (```json ... ```)
  text = text.replace(/```[\w]*\n?/g, '').trim();

  // If the whole thing looks like a JSON object, extract the text field
  if (text.startsWith('{') && text.endsWith('}')) {
    try {
      const parsed = JSON.parse(text);
      if (parsed.text) return parsed.text;
    } catch { /* not valid JSON, keep going */ }
  }

  // Remove embedded JSON fragments like {"action": ...} mid-sentence
  text = text.replace(/\{[^}]{5,}\}/g, '').trim();

  // Remove stray JSON array fragments
  text = text.replace(/\[[^\]]{5,}\]/g, '').trim();

  return text;
}

// ── Clean text before sending to TTS ──
// Strips artifacts that sound wrong when spoken aloud
function cleanForTTS(text) {
  if (!text) return null;

  let cleaned = text;

  // Strip leading/trailing dots, commas, spaces
  cleaned = cleaned.replace(/^[\s.,]+|[\s.,]+$/g, '').trim();

  // Collapse multiple spaces / newlines into single space
  cleaned = cleaned.replace(/\s+/g, ' ');

  // Remove stray JSON-like fragments that extractSpeakableText may have missed
  cleaned = cleaned.replace(/\{[^}]*\}/g, '').trim();
  cleaned = cleaned.replace(/\[[^\]]*\]/g, '').trim();

  // Remove leading/trailing quotes if the whole string is quoted
  if ((cleaned.startsWith('"') && cleaned.endsWith('"')) ||
      (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
    cleaned = cleaned.slice(1, -1).trim();
  }

  // If nothing left or it's a skip response, return null
  if (!cleaned || SKIP_RESPONSES.has(cleaned)) return null;

  return cleaned;
}

// ── Truncate text for TTS — hard cap at N chars, cut at word boundary ──
function truncateForTTS(text, maxChars = 120) {
  if (!text || text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 20 ? cut.slice(0, lastSpace) : cut) + '.';
}

// ── Shorten a calendar event name to first 3 words max ──
function shortName(str) {
  if (!str) return 'Meeting';
  const words = str.split(/\s+/);
  if (words.length <= 3) return str;
  return words.slice(0, 3).join(' ');
}

// ── Shorten a job title (first 3 words) ──
function shortTitle(str) {
  if (!str) return '';
  const words = str.split(/\s+/);
  if (words.length <= 3) return str;
  return words.slice(0, 3).join(' ');
}

// ── Format time from event start ──
function fmtTime(e) {
  if (!e?.start) return '';
  return new Date(e.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// ── Format raw integration data into speakable text ──
function formatDataForSpeech(actionType, data) {
  if (!data) return null;

  if (typeof data === 'string') return truncateForTTS(data);

  // Calendar: { calendarEvents, salesforceTasks, fellowMeetings }
  if (actionType === 'check_calendar' || actionType === 'get_calendar' || actionType === 'get_schedule') {
    const events = data.calendarEvents || data.events || (Array.isArray(data) ? data : null);
    if (events) {
      if (events.length === 0) return "You're clear, no meetings.";
      const first = events[0];
      const time = fmtTime(first);
      if (events.length === 1) {
        return truncateForTTS(`One meeting: ${shortName(first.summary)} at ${time}.`);
      }
      return truncateForTTS(`${events.length} meetings. First: ${shortName(first.summary)} at ${time}.`);
    }
  }

  // Contact: { salesforce, salesloft, recentEmails, meetingNotes }
  if (actionType === 'lookup_contact' || actionType === 'search_contact') {
    // Direct contact object
    if (data.name) {
      const title = shortTitle(data.title || data.Title || '');
      const company = data.company || data.account || data['Account.Name'] || '';
      return truncateForTTS(`${data.name}${title ? ', ' + title : ''}${company ? ' at ' + company : ''}.`);
    }
    // IntegrationManager shape
    const contacts = data.salesforce || data.salesloft || [];
    if (Array.isArray(contacts) && contacts.length > 0) {
      const c = contacts[0];
      const name = [c.FirstName, c.LastName].filter(Boolean).join(' ') || c.Name || 'Unknown';
      const title = shortTitle(c.Title || '');
      const company = c.Account?.Name || c['Account.Name'] || '';
      const more = contacts.length > 1 ? ` Plus ${contacts.length - 1} more.` : '';
      return truncateForTTS(`${name}${title ? ', ' + title : ''}${company ? ' at ' + company : ''}.${more}`);
    }
    if (Array.isArray(contacts) && contacts.length === 0) return 'No contacts found.';
  }

  // Account: { account, salesloft, opportunities, news }
  if (actionType === 'lookup_account' || actionType === 'account_brief') {
    const acct = data.account || data;
    if (acct?.Name || acct?.name) {
      const name = acct.Name || acct.name;
      const industry = acct.Industry || '';
      const opps = data.opportunities || [];
      const oppStr = opps.length > 0 ? ` ${opps.length} deal${opps.length > 1 ? 's' : ''} open.` : '';
      return truncateForTTS(`${name}${industry ? ', ' + industry : ''}.${oppStr}`);
    }
  }

  // Research
  if (actionType === 'research' || actionType === 'search_web') {
    if (data.results && Array.isArray(data.results) && data.results.length > 0) {
      return truncateForTTS(data.results[0].snippet || data.results[0].title || 'No results.');
    }
    if (data.summary) return truncateForTTS(data.summary);
  }

  // Email
  if (actionType === 'check_email' || actionType === 'search_email') {
    if (Array.isArray(data)) {
      if (data.length === 0) return 'No emails found.';
      const from = (data[0].from || 'unknown').split('<')[0].trim();
      return truncateForTTS(`${data.length} email${data.length > 1 ? 's' : ''}. Latest from ${from}.`);
    }
  }

  // Time
  if (actionType === 'check_time' || actionType === 'get_time') {
    return data.text || `It's ${data.time}.`;
  }

  // Pipeline
  if (actionType === 'get_pipeline' || actionType === 'check_pipeline') {
    if (Array.isArray(data)) {
      if (data.length === 0) return 'Pipeline is empty.';
      return truncateForTTS(`${data.length} deal${data.length > 1 ? 's' : ''} in pipeline.`);
    }
    if (data.text) return truncateForTTS(data.text);
  }

  // Generic fallback — if data has a .text field, speak it
  if (data.text) return truncateForTTS(data.text);

  return null;
}

// ── Determine speech pacing from brain response context ──
function determinePace(response) {
  if (response.intent === 'urgent' || response.state === 'action_requested') {
    return 'urgent';
  }
  const hour = new Date().getHours();
  if (hour >= 22 || hour < 6) return 'calm';
  return 'normal';
}

// ── Fire-and-forget action dispatch (background, non-blocking) ──
function dispatchBgActions(actions) {
  for (const action of actions) {
    dispatchAction(action)
      .then((result) => {
        if (result) {
          log.info(`Background action completed: ${action.action}`);
        }
      })
      .catch((err) => {
        log.error(`Background action ${action.action} failed:`, err.message);
      });
  }
}

// ── Update semantic memory from brain-detected entities ──
function updateSemanticMemory(entities) {
  for (const entity of entities) {
    try {
      if (entity.type === 'person') {
        memory.semantic.upsertContact({
          name: entity.name,
          aliases: entity.aliases || [],
          source: 'brain_detection',
        });
      } else if (entity.type === 'company') {
        memory.semantic.upsertAccount({
          name: entity.name,
          source: 'brain_detection',
        });
      }
    } catch (err) {
      log.debug(`Failed to update semantic memory for ${entity.name}:`, err.message);
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  CONVERSATION END DETECTION
//  When we stay in LISTENING for 60s after a conversation, trigger learning.
//  Razor never goes to IDLE automatically — always stays in LISTENING.
// ══════════════════════════════════════════════════════════════════════════

let idleTimer = null;

sm.onEnter(States.LISTENING, () => {
  // Reset the idle timer every time we enter LISTENING.
  // If a conversation was active and we sit in LISTENING for 60s
  // without any new wake word, the conversation is over — run learning.
  clearTimeout(idleTimer);

  if (conversationActive) {
    idleTimer = setTimeout(async () => {
      if (sm.getState().state === States.LISTENING && conversationActive) {
        log.info('Conversation idle timeout — triggering learning cycle');
        conversationActive = false;

        sm.transition(States.LEARNING, 'conversation_end', {
          contextUpdate: {},
          sessionAnalysis: {
            topic: 'voice_interaction',
            outcome: 'completed',
            summary: `Voice conversation with ${memory.working.turns?.length || 0} turns`,
          },
        });
      }
    }, 60000); // 60s of listening silence = conversation ended
    if (idleTimer.unref) idleTimer.unref();
  }
});

// ══════════════════════════════════════════════════════════════════════════
//  RESEARCHING STATE HOOK
// ══════════════════════════════════════════════════════════════════════════

sm.onEnter(States.RESEARCHING, async (record) => {
  const query = record?.metadata?.researchQuery;
  if (query) {
    log.info(`RESEARCHING: "${query}"`);
    try {
      const result = await integrations.research(query);
      if (brain.connected && result?.summary) {
        const response = await brain.process(
          `[RESEARCH RESULTS] ${result.summary}`,
          { type: 'research_results', query },
        );
        if (response?.text) {
          await pipeline.speak(response.text, { pace: 'normal' });
        }
      }
    } catch (err) {
      log.error('Research failed:', err.message);
    }
    if (sm.canTransition(States.PROCESSING)) {
      sm.transition(States.PROCESSING, 'research_complete');
    } else {
      sm.transition(States.IDLE, 'research_complete');
    }
  }
});

// ══════════════════════════════════════════════════════════════════════════
//  COMPONENT EVENT LISTENERS
// ══════════════════════════════════════════════════════════════════════════

brain.on('connected', () => log.info('🧠 Brain server connected'));
brain.on('disconnected', () => log.warn('🧠 Brain server disconnected — offline mode'));

integrations.on('integration:ready', ({ service }) => log.info(`Integration ready: ${service}`));
integrations.on('integration:error', ({ service, error }) => {
  log.error(`Integration error (${service}):`, error?.message || error);
});

memory.on('memory:reflected', (result) => {
  log.info('Memory reflection complete:', JSON.stringify(result).slice(0, 100));
});

// ══════════════════════════════════════════════════════════════════════════
//  GRACEFUL SHUTDOWN
// ══════════════════════════════════════════════════════════════════════════

async function shutdown() {
  log.info('\nShutting down Razor...');
  clearTimeout(idleTimer);

  if (conversationActive) {
    try {
      await memory.endConversation({
        topic: 'voice_interaction',
        outcome: 'shutdown',
        summary: 'System shutdown during conversation',
      });
    } catch (err) {
      log.warn('Failed to save conversation on shutdown:', err.message);
    }
  }

  await pipeline.stop();
  await brain.disconnect();
  log.info('Razor shutdown complete');
  process.exit(0);
}

// ══════════════════════════════════════════════════════════════════════════
//  MAIN
// ══════════════════════════════════════════════════════════════════════════

async function main() {
  log.info('');
  log.info('┌─────────────────────────────────────────┐');
  log.info('│  🔪 Razor Voice Assistant                │');
  log.info('│  Starting up...                          │');
  log.info('└─────────────────────────────────────────┘');
  log.info('');

  // ── Signal handlers ──
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('uncaughtException', (err) => {
    log.error('Uncaught exception:', err);
    shutdown();
  });
  process.on('unhandledRejection', (err) => {
    log.error('Unhandled rejection:', err);
  });

  // ── 1. Voice pipeline ──
  log.info('[1/4] Initializing voice pipeline...');
  await pipeline.init();

  // ── 2. Brain (non-blocking — works offline) ──
  log.info('[2/4] Connecting to brain server...');
  try {
    await Promise.race([
      brain.connect(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
    ]);
    log.info('Brain connected ✓');
  } catch {
    log.warn('Brain server not available — starting in offline mode');
  }

  // ── 3. Integrations (non-blocking) ──
  log.info('[3/4] Initializing integrations...');
  try {
    const live = await integrations.initialize();
    log.info(`Integrations: ${live.length ? live.join(', ') : '(none configured)'}`);
  } catch (err) {
    log.warn('Integration init failed:', err.message);
  }

  // ── 4. Wire events and start ──
  log.info('[4/4] Starting pipeline...');

  pipeline.on('command', handleCommand);

  pipeline.on('command:partial', ({ text }) => {
    process.stdout.write(`\r  🎤 ${text}                    `);
  });

  pipeline.on('command:timeout', () => {
    log.info('No command received — returning to idle');
  });

  pipeline.on('state', (newState) => {
    process.stdout.write(`\x1b]0;Razor [${newState}]\x07`);
  });

  await pipeline.start();

  log.info('');
  log.info('┌─────────────────────────────────────────┐');
  log.info('│  🎙  Razor is running                    │');
  log.info('│  Say "Razor" followed by a command       │');
  log.info('│                                          │');
  log.info(`│  Brain:        ${brain.connected ? '✓ connected' : '✗ offline'}             │`);
  log.info(`│  Integrations: ${integrations._liveServices().length} active               │`);
  log.info('│  Press Ctrl+C to stop                    │');
  log.info('└─────────────────────────────────────────┘');
  log.info('');
}

main().catch((err) => {
  log.error('Fatal error:', err);
  process.exit(1);
});
