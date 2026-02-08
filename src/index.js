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
import { getConversationContext } from "./context/conversation-context.js";
import { queryCache } from './intelligence/query-cache.js';
import { morningBriefing } from './intelligence/morning-briefing.js';
import makeLogger from './utils/logger.js';
import speechLogger from "./utils/speech-logger.js";

const log = makeLogger('Main');
const sm = getStateMachine();

// ── Component Instances ──
const pipeline = new VoicePipeline();
const memory = new MemoryAgent();
const integrations = new IntegrationManager();
const brain = getBrainConnector();
const convContext = getConversationContext();

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
  // Additional Salesforce
  'get_stale_deals', 'stale_deals', 'deals_gone_dark',
  'get_deals_closing', 'closing_this_week', 'closing_this_month', 'deals_closing',
  'get_decision_maker', 'decision_maker', 'who_is_decision_maker',
  'get_deal_by_name', 'deal_status', 'tell_me_about_deal',
  'get_sf_tasks', 'salesforce_tasks', 'my_tasks',
  'get_upcoming_tasks', 'upcoming_tasks',
  // Morning briefing
  'morning_briefing', 'daily_briefing', 'give_briefing',
  // Google Calendar & Email
  'get_upcoming_events', 'whats_on_calendar', 'my_calendar', 'meetings_this_week',
  'find_free_time', 'am_i_free', 'free_slots',
  'get_unread_emails', 'any_new_emails', 'unread_emails',
  'search_emails', 'emails_from',
]);

async function dispatchAction(action) {
  const type = action.action || action.type;
  const params = action.params || {};

  log.info(`Dispatching action: ${type}`);

  try {
    switch (type) {
      case 'morning_briefing':
      case 'daily_briefing':
      case 'give_briefing': {
        // Trigger morning briefing manually — assemble and return as text
        await morningBriefing.deliver();
        return null; // deliver() speaks directly, no need to return text
      }

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
          return `You have ${leads.length} hot lead${leads.length > 1 ? "s" : ""} including ${top3}`;
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
          return `${opens.length} people opened your emails including ${top3}`;
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
          return `${clicks.length} people clicked your emails including ${top3}`;
        }
        return "Salesloft not connected.";
      }

      case 'get_replies':
      case 'who_replied': {
        if (integrations.salesloft) {
          const replies = await integrations.salesloft.getReplies();
          if (!replies?.length) return "No replies recently.";
          const top3 = replies.slice(0, 3).map(r => r.name || r.email).join(", ");
          return `You got ${replies.length} repl${replies.length > 1 ? "ies" : "y"} from ${top3}`;
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
          return `You have ${cadences.length} active cadence${cadences.length > 1 ? "s" : ""} including ${top3}`;
        }
        return "Salesloft not connected.";
      }

      case 'get_activity_stats':
      case 'activity_stats': {
        if (integrations.salesloft) {
          const stats = await integrations.salesloft.getActivityStats();
          if (!stats) return "Could not get activity stats.";
          return `Today you made ${stats.calls || 0} calls and sent ${stats.emails || 0} emails`;
        }
        return "Salesloft not connected.";
      }


      case 'get_stale_deals':
      case 'stale_deals':
      case 'deals_gone_dark': {
        if (integrations.salesforce) {
          const deals = await integrations.salesforce.getStaleDeals(7);
          if (!deals?.length) return "No stale deals. Pipeline is active.";
          const top3 = deals.slice(0, 3).map(d => d.Account?.Name || d.Name?.split(" - ")[0] || "Unknown").join(", ");
          return `You have ${deals.length} deal${deals.length > 1 ? "s" : ""} with no activity in the last week including ${top3}`;
        }
        return "Salesforce not connected.";
      }

      case 'get_deals_closing':
      case 'closing_this_week':
      case 'closing_this_month':
      case 'deals_closing': {
        if (integrations.salesforce) {
          const period = params.period || "this_week";
          const deals = await integrations.salesforce.getDealsClosing(period);
          if (!deals?.length) return `No deals closing ${period.replace("_", " ")}.`;
          const total = deals.reduce((sum, d) => sum + (d.Amount || 0), 0);
          const top3 = deals.slice(0, 3).map(d => d.Account?.Name || d.Name?.split(" - ")[0] || "Unknown").join(", ");
          return `${deals.length} deal${deals.length > 1 ? "s" : ""} closing ${period.replace("_", " ")} worth ${Math.round(total/1000)} thousand total including ${top3}`;
        }
        return "Salesforce not connected.";
      }

      case 'get_decision_maker':
      case 'decision_maker':
      case 'who_is_decision_maker': {
        if (integrations.salesforce) {
          const company = params.company || params.account || params.name;
          if (!company) return "Which company?";
          const dm = await integrations.salesforce.getDecisionMaker(company);
          if (!dm) return `No decision maker found for ${company}.`;
          return `The decision maker at ${company} is ${dm.Name}${dm.Title ? " who is " + dm.Title : ""}`;
        }
        return "Salesforce not connected.";
      }

      case 'get_deal_by_name':
      case 'deal_status':
      case 'tell_me_about_deal': {
        if (integrations.salesforce) {
          const name = params.name || params.company || params.deal;
          if (!name) return "Which deal?";
          const deal = await integrations.salesforce.getDealByName(name);
          if (!deal) return `No deal found for ${name}.`;
          const amt = deal.Amount ? (deal.Amount >= 1000 ? `${Math.round(deal.Amount/1000)} thousand` : `${deal.Amount}`) : "unknown amount";
          const stage = deal.StageName || "unknown stage";
          return `${deal.Account?.Name || name} is at ${amt || "unknown amount"} in ${stage}${deal.CloseDate ? " closing " + deal.CloseDate : ""}`;
        }
        return "Salesforce not connected.";
      }


      // ═══════════════════════════════════════════════════════════════════════
      // GOOGLE — Calendar & Email
      // ═══════════════════════════════════════════════════════════════════════

      case 'get_upcoming_events':
      case 'whats_on_calendar':
      case 'my_calendar':
      case 'meetings_this_week': {
        if (integrations.google) {
          const days = params.days || 1;
          const events = await integrations.google.getUpcomingEvents(days);
          if (!events?.length) return days === 1 ? "No meetings today." : `No meetings in the next ${days} days.`;
          const top3 = events.slice(0, 3).map(e => e.summary || "Untitled").join(", ");
          return `You have ${events.length} meeting${events.length > 1 ? "s" : ""} including ${top3}`;
        }
        return "Google not connected.";
      }

      case 'find_free_time':
      case 'am_i_free':
      case 'free_slots': {
        if (integrations.google) {
          const slots = await integrations.google.findFreeSlots(params.start, params.end, params.duration || 30);
          if (!slots?.length) return "No free slots found.";
          return `Found ${slots.length} free slot${slots.length > 1 ? "s" : ""} and the first one is at ${slots[0].start}`;
        }
        return "Google not connected.";
      }

      case 'get_unread_emails':
      case 'check_email':
      case 'any_new_emails':
      case 'unread_emails': {
        if (integrations.google) {
          const emails = await integrations.google.getUnreadEmails(5);
          if (!emails?.length) return "No unread emails.";
          const top3 = emails.slice(0, 3).map(e => e.from?.split("<")[0]?.trim() || "Unknown").join(", ");
          return `You have ${emails.length} unread email${emails.length > 1 ? "s" : ""} from ${top3}`;
        }
        return "Google not connected.";
      }

      case 'search_emails':
      case 'emails_from': {
        if (integrations.google) {
          const query = params.query || params.from || params.person;
          if (!query) return "Who should I search for?";
          const emails = await integrations.google.searchEmails(query, 5);
          if (!emails?.length) return `No emails found for ${query}.`;
          return `Found ${emails.length} email${emails.length > 1 ? "s" : ""} matching ${query}.`;
        }
        return "Google not connected.";
      }

      case 'get_sf_tasks':
      case 'salesforce_tasks':
      case 'my_tasks': {
        if (integrations.salesforce) {
          const tasks = await integrations.salesforce.getTasks();
          if (!tasks?.length) return "No open Salesforce tasks.";
          const top3 = tasks.slice(0, 3).map(t => t.Subject || "Untitled").join(" and ");
          return `You have ${tasks.length} task${tasks.length > 1 ? "s" : ""} including ${top3}`;
        }
        return "Salesforce not connected.";
      }

      case 'get_upcoming_tasks':
      case 'upcoming_tasks': {
        if (integrations.salesforce) {
          const tasks = await integrations.salesforce.getUpcomingTasks(7);
          if (!tasks?.length) return "No upcoming tasks this week.";
          const top3 = tasks.slice(0, 3).map(t => t.Subject || "Untitled").join(" and ");
          return `You have ${tasks.length} upcoming task${tasks.length > 1 ? "s" : ""} including ${top3}`;
        }
        return "Salesforce not connected.";
      }

      case 'get_biggest_deal':
      case 'biggest_deal':
      case 'largest_deal': {
        if (integrations.salesforce) {
          const opps = await integrations.salesforce.queryOpportunities({ orderBy: "Amount DESC", limit: 1 });
          if (!opps?.length) return "No open deals found.";
          const deal = opps[0];
          const amt = deal.Amount ? (deal.Amount >= 1000 ? `${Math.round(deal.Amount/1000)} thousand` : `${deal.Amount}`) : "unknown amount";
          const name = (deal.Name || "").replace(/[:-]/g, " ").split(" ").slice(0,3).join(" ") || deal.Account?.Name || "Unknown";
          const stage = deal.StageName || "unknown stage";
          return `Your biggest deal is ${name} at ${amt} in ${stage}`;
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
          const top3 = items.slice(0, 3).map(i => i.title || i.text).join(" and ");
          return `You have ${items.length} action item${items.length > 1 ? "s" : ""} including ${top3}`;
        }
        return "Fellow not connected.";
      }

      case 'get_overdue_items':
      case 'overdue_tasks': {
        if (integrations.fellow) {
          const items = await integrations.fellow.getOverdueItems();
          if (!items?.length) return "Nothing overdue. You are all caught up.";
          const top3 = items.slice(0, 3).map(i => i.title || i.text).join(" and ");
          return `You have ${items.length} overdue item${items.length > 1 ? "s" : ""} including ${top3}`;
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
          return summary.summary || `Your last meeting was ${summary.title}`;
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
          return `Your talk ratio was ${analytics.userTalkRatio || "unknown"}${analytics.summary ? " and " + analytics.summary : ""}`;
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
          return `You have ${meetings.length} meeting${meetings.length > 1 ? "s" : ""} today including ${names}`;
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
          const top3 = items.slice(0, 3).map(i => i.title || i.text).join(" and ");
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
//  CONTEXT-AWARE FOLLOW-UP RESOLUTION (Layer 2 & 3)
//  Resolves references like "the first one", "call them", "tell me more"
// ══════════════════════════════════════════════════════════════════════════

/**
 * Check if user input is a follow-up and resolve to concrete action
 * Returns null if not a follow-up, or { action, params, speakText } if resolved
 */
async function resolveFollowUp(text) {
  if (!convContext.isContextFresh()) return null;
  
  const followUp = convContext.detectFollowUpIntent(text);
  if (!followUp.isFollowUp) return null;
  
  log.info(`[Context] Follow-up detected: ${followUp.action}`);
  
  const resolved = followUp.resolvedEntity;
  if (!resolved) {
    log.info('[Context] No entity to resolve');
    return null;
  }
  
  // Handle different follow-up actions
  switch (followUp.action) {
    case 'call_entity': {
      if (resolved.type === 'single' && resolved.entity) {
        const entity = resolved.entity;
        if (entity.phone) {
          return { speakText: `Calling ${entity.name} at ${entity.phone}` };
        }
        // Need to look up phone
        if (entity.type === 'person' && entity.name) {
          return { 
            action: 'lookup_contact', 
            params: { name: entity.name },
            postProcess: (result) => {
              if (result?.phone) return `${entity.name}'s number is ${result.phone}`;
              return `I don't have a phone number for ${entity.name}`;
            }
          };
        }
      }
      return { speakText: "Who should I call?" };
    }
    
    case 'email_entity': {
      if (resolved.type === 'single' && resolved.entity) {
        const entity = resolved.entity;
        return { 
          action: 'draft_email',
          params: { to: entity.email || entity.name },
          speakText: `I'll draft an email to ${entity.name}`
        };
      }
      if (resolved.type === 'multiple') {
        const names = resolved.entities.slice(0, 3).map(e => e.name).join(', ');
        return { speakText: `I'll draft an email to ${names}` };
      }
      return { speakText: "Who should I email?" };
    }
    
    case 'expand_entity':
    case 'lookup_entity': {
      if (resolved.type === 'single' && resolved.entity) {
        const entity = resolved.entity;
        if (entity.type === 'person') {
          return { action: 'lookup_contact', params: { name: entity.name } };
        }
        if (entity.type === 'deal') {
          return { action: 'get_deal_by_name', params: { name: entity.name } };
        }
        if (entity.type === 'company') {
          return { action: 'lookup_account', params: { name: entity.company || entity.name } };
        }
        // Generic expand - just describe what we have
        const details = [];
        if (entity.name) details.push(entity.name);
        if (entity.company) details.push(`at ${entity.company}`);
        if (entity.amount) details.push(`${Math.round(entity.amount/1000)} thousand`);
        if (entity.stage) details.push(`in ${entity.stage}`);
        if (details.length > 0) {
          return { speakText: details.join(' ') };
        }
      }
      return null;
    }
    
    case 'expand_last':
    case 'continue_list': {
      // Request more from the last action
      const lastAction = convContext.lastAction;
      if (lastAction) {
        return { 
          action: lastAction, 
          params: { expanded: true, skip: convContext.lastEntities.length }
        };
      }
      return { speakText: "What would you like me to expand on?" };
    }
    
    case 'suggest_action':
    case 'prioritize': {
      // Use pending follow-ups
      const suggestion = convContext.getProactiveFollowUp();
      if (suggestion) {
        return { speakText: suggestion };
      }
      if (convContext.lastEntities.length > 0) {
        const first = convContext.lastEntities[0];
        if (first.type === 'person') {
          return { speakText: `I'd start with ${first.name} — they seem most engaged` };
        }
        if (first.type === 'deal') {
          return { speakText: `Focus on ${first.name} — it's your biggest opportunity` };
        }
      }
      return { speakText: "What's your top priority right now?" };
    }
    
    case 'breakdown': {
      const lastAction = convContext.lastAction;
      if (lastAction === 'get_pipeline') {
        return { action: 'get_pipeline_by_stage', params: {} };
      }
      return { speakText: "Break down by what — stage, company, or time?" };
    }
    
    default:
      return null;
  }
}

/**
 * Update context after successful data response
 */
function updateConversationContext(actionName, rawData, formattedText) {
  convContext.updateContext(actionName, rawData, formattedText);
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
  const _cmdStartMs = Date.now();
  const _isFollowUp = source === 'streaming-stt' && !source.includes('wake');

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


  // ── Layer 2/3: Check for context-aware follow-up ──
  const followUpResult = await resolveFollowUp(text);
  if (followUpResult) {
    log.info("[Context] Resolved follow-up:", followUpResult);
    if (followUpResult.speakText && !followUpResult.action) {
      // Direct response without needing data fetch
      memory.addTurn("assistant", followUpResult.speakText, { contextResolved: true });
      await pipeline.speak(followUpResult.speakText, { pace: "calm" });
      return;
    }
    if (followUpResult.action) {
      // Inject resolved action into processing
      const result = await dispatchAction({ action: followUpResult.action, params: followUpResult.params || {} });
      if (result) {
        const formatted = humanizeResponse(formatDataForSpeech(followUpResult.action, result));
        updateConversationContext(followUpResult.action, result, formatted);
        memory.addTurn("assistant", formatted, { contextResolved: true });
        await pipeline.speak(formatted, { pace: "calm" });
        return;
      }
    }
  }

  // ── If brain is connected, use it ──
  if (brain.connected) {
    try {
      // Set up early TTS pre-synthesis via streaming
      let preSynthPromise = null;
      let preSynthText = null;

      const onTtsChunk = ({ text: chunkText }) => {
        if (pipeline._turn && !pipeline._turn.brainFirstChunkAt) pipeline._turn.brainFirstChunkAt = Date.now();
        const cleaned = cleanForTTS(extractSpeakableText(chunkText));
        if (cleaned) {
          preSynthText = cleaned;
          preSynthPromise = pipeline.tts.synthesize(cleaned, { pace: 'normal' }).catch(() => null);
          log.info(`[Streaming] Pre-synthesizing TTS: "${cleaned.slice(0, 60)}..."`);
        }
      };
      brain.once('brain:tts_chunk', onTtsChunk);

      if (pipeline._turn) pipeline._turn.brainRequestedAt = Date.now();
      const response = await brain.process(text, {
        source,
        memoryContext: memory.getContext(),
      }, true); // stream=true for early TTS

      brain.removeListener('brain:tts_chunk', onTtsChunk);

      if (pipeline._turn) {
        pipeline._turn.brainRespondedAt = Date.now();
        pipeline._turn.brainMs = pipeline._turn.brainRequestedAt ? Date.now() - pipeline._turn.brainRequestedAt : 0;
        pipeline._turn.intent = response.intent || 'unknown';
      }

      let speakText = extractSpeakableText(response.text);
      if (pipeline._userStoppedAt) {
        log.info(`[Latency] Brain responded at ${Date.now()} — ${Date.now() - pipeline._userStoppedAt}ms after user stopped`);
      }
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
        if (pipeline._turn) pipeline._turn.dataFetchStartedAt = Date.now();

        const results = await Promise.all(
          dataActions.map(async (a) => {
            // Check cache first
            const cached = queryCache.get(a.action, a.params);
            if (cached) {
              log.info(`[Cache] HIT for ${a.action}`);
              if (pipeline._turn) pipeline._turn.cacheHit = true;
              return { action: a.action, params: a.params, result: cached };
            }
            const result = await dispatchAction(a);
            // Cache the result for future queries
            if (result != null) queryCache.set(a.action, result, undefined, a.params);
            return { action: a.action, params: a.params, result };
          }),
        );

        if (pipeline._turn) {
          pipeline._turn.dataFetchEndedAt = Date.now();
          pipeline._turn.dataFetchMs = pipeline._turn.dataFetchStartedAt ? Date.now() - pipeline._turn.dataFetchStartedAt : 0;
          for (const r of results) {
            pipeline._turn.actions.push({ action: r.action, succeeded: r.result != null });
          }
        }

        const fetched = results.filter(r => r.result != null);
        const failedCount = dataActions.length - fetched.length;
        if (failedCount > 0) pipeline._sessionStats.actionsFailed += failedCount;
        if (fetched.length > 0) {
          const dataSummary = fetched
            .map(r => formatDataForSpeech(r.action, r.result))
            .filter(Boolean)
            .join(' ');
          if (dataSummary) {
            speakText = humanizeResponse(dataSummary);
            log.info(`Data response: "${speakText.slice(0, 80)}${speakText.length > 80 ? '...' : ''}"`);
            // Update conversation context with fetched data
            fetched.forEach(r => updateConversationContext(r.action, r.result, formatDataForSpeech(r.action, r.result)));
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
      // Clean and naturalize for TTS
      if (pipeline._turn) pipeline._turn.spokenText = speakText;
      const originalText = speakText;
      speakText = cleanForTTS(speakText);
      speakText = speechLogger.makeNatural(speakText);
      
      // Log TTS transformation
      speechLogger.logTTSInput(originalText, speakText, "brain response");
      
      // Check for naturalness issues
      const issues = speechLogger.analyzeNaturalness(speakText);
      if (issues.length > 0) {
        speechLogger.logNaturalnessIssues(speakText, issues);
      }
      
      if (!speakText) {
        log.info("Skipping TTS — empty or placeholder response after cleaning");
        pipeline._sessionStats.silentResponses++;
        if (pipeline._turn) pipeline._turn.flags.push('empty_response');
        pipeline._endTurn();
        sm.transition(States.LISTENING, "empty_response");
        return;
      }

      // ── [Humanness] Naturalness score ──
      const { score: natScore, issues: natIssues } = scoreNaturalness(speakText);
      const natEmoji = natScore >= 8 ? '🟢' : natScore >= 5 ? '🟡' : '🔴';
      log.info(`[Humanness] ${natEmoji} Score: ${natScore}/10 | ${natIssues.join(', ')} | "${speakText.slice(0, 80)}..."`);

      // Record brain turn in memory
      memory.addTurn('assistant', speakText, {
        intent: response.intent,
        entities: response.entities,
      });

      // Speak the response — use pre-synthesized audio if available
      const pace = determinePace(response);

      // For non-data responses, check if pre-synthesis completed
      if (preSynthPromise && dataActions.length === 0) {
        const preSynthResult = await Promise.race([
          preSynthPromise,
          new Promise(resolve => setTimeout(() => resolve(null), 2000)),
        ]);

        // Use pre-synth if the text matches (hasn't been modified by humanization etc.)
        if (preSynthResult && preSynthText === cleanForTTS(extractSpeakableText(response.text))) {
          log.info('[Streaming] Using pre-synthesized audio');
          await pipeline.speakPreSynthesized(preSynthResult, { pace });
        } else {
          if (preSynthResult) log.info('[Streaming] Text changed after pre-synth, re-synthesizing');
          await pipeline.speak(speakText, { pace });
        }
      } else {
        await pipeline.speak(speakText, { pace });
      }

      // ── [Session] Turn tracking ──
      const responseTimeMs = Date.now() - _cmdStartMs;
      const actionName = allActions.length > 0 ? allActions[0].action : 'no_action';
      pipeline._sessionStats.turns++;
      pipeline._sessionStats.totalResponseMs += responseTimeMs;
      pipeline._sessionStats.actionsTriggered += allActions.length;
      if (_isFollowUp) { pipeline._sessionStats.followUps++; } else { pipeline._sessionStats.wakeWords++; }
      log.info(`[Session] Turn ${pipeline._sessionStats.turns}: "${text.slice(0, 40)}" → ${actionName} (${responseTimeMs}ms) ${_isFollowUp ? '↩️ follow-up' : '🎯 wake-word'}`);

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

// ── Humanize data response text for natural-sounding TTS ──
function humanizeResponse(text) {
  if (!text) return text;

  let r = text;

  // "You have X hot leads" → more casual phrasing
  r = r.replace(/^You have (\d+) hot leads?/i, (_, n) => {
    const num = parseInt(n);
    if (num === 0) return 'No hot leads right now';
    if (num === 1) return 'Just one hot lead';
    if (num <= 3) return `Got ${n} hot ones`;
    return `You've got ${n} hot leads`;
  });

  // "You have X deal" → shorter
  r = r.replace(/^You have (\d+) deal/i, (_, n) => {
    return parseInt(n) === 1 ? 'One deal' : `${n} deals`;
  });

  // "including" → more natural connector
  r = r.replace(/ including /, '. Top names: ');

  // "with no activity in the last week" → shorter
  r = r.replace(/with no activity in the last (\w+)/i, 'gone quiet this $1');

  // "worth X thousand in total pipeline" → shorter
  r = r.replace(/worth (\d+) thousand in total pipeline/i, 'totaling $1K in pipeline');

  // Empty-result responses → casual
  r = r.replace(/^No unread emails\.?$/i, 'Inbox is clean.');
  r = r.replace(/^No open action items right now\.?$/i, 'Nothing on your plate from meetings.');
  r = r.replace(/^No upcoming tasks this week\.?$/i, 'Clear schedule this week.');
  r = r.replace(/^No deals closing this (\w+)\.?$/i, 'Nothing closing this $1.');
  r = r.replace(/^No recent recordings to analyze\.?$/i, 'No recent calls to look at.');

  // Clean up colons and double spaces before TTS
  r = r.replace(/:\s*/g, ', ');
  r = r.replace(/\s{2,}/g, ' ');

  return r.trim();
}

// ── [Humanness] Score response naturalness before TTS ──
function scoreNaturalness(text) {
  if (!text || text.length < 2) return { score: 0, issues: ['empty'] };

  const issues = [];
  let score = 10;

  // Too long for voice
  const wordCount = text.split(/\s+/).length;
  if (wordCount > 25) { score -= 2; issues.push(`too_long(${wordCount}w)`); }
  if (wordCount > 40) { score -= 2; issues.push('way_too_long'); }

  // Robotic openers
  const roboticStarts = [/^I can help/i, /^I'd be happy/i, /^Certainly/i, /^Of course/i, /^Sure,? I/i, /^Let me help/i, /^Here are your/i];
  for (const r of roboticStarts) {
    if (r.test(text)) { score -= 2; issues.push('robotic_opener'); break; }
  }

  // Robotic closers
  const roboticEnds = [/anything else\??$/i, /help you with\??$/i, /assist you\??$/i, /let me know\.?$/i];
  for (const r of roboticEnds) {
    if (r.test(text)) { score -= 2; issues.push('robotic_closer'); break; }
  }

  // Numbered lists
  if (/\d+\.\s/.test(text)) { score -= 2; issues.push('numbered_list'); }

  // No contractions (sounds formal)
  if (/\b(You have|I will|That is|Here is|It is|I am|You are)\b/.test(text)) {
    score -= 1; issues.push('no_contractions');
  }

  // Raw data artifacts
  if (/:/.test(text)) { score -= 1; issues.push('has_colons'); }
  if (/\|/.test(text)) { score -= 2; issues.push('has_pipes'); }
  if (/null|undefined|NaN/i.test(text)) { score -= 3; issues.push('raw_data_leak'); }

  // Good signs
  if (/^(So|Alright|Got it|Here's the deal|Quick|Yeah|Oh)/i.test(text)) { score += 1; issues.push('+natural_opener'); }
  if (/you've|they're|we're|it's|that's|here's|what's|who's/i.test(text)) { score += 1; issues.push('+has_contractions'); }

  return { score: Math.max(0, Math.min(10, score)), issues };
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
  morningBriefing.stop();

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

  // ── Register prefetch callbacks for frequently-used queries ──
  if (integrations.google) {
    queryCache.registerPrefetch('check_calendar', () => integrations.getUpcomingSchedule(1));
    queryCache.registerPrefetch('get_unread_emails', () => integrations.google.getUnreadEmails(5));
  }
  if (integrations.salesforce) {
    queryCache.registerPrefetch('get_pipeline', () => integrations.salesforce.getPipeline());
  }
  if (integrations.fellow) {
    queryCache.registerPrefetch('get_action_items', () => integrations.fellow.getMyActionItems());
    queryCache.registerPrefetch('get_today_meetings', () => integrations.fellow.getTodaysMeetings());
  }

  // ── 4. Wire events and start ──
  log.info('[4/4] Starting pipeline...');

  pipeline.on('command', handleCommand);

  pipeline.on('command:partial', ({ text }) => {
    process.stdout.write(`\r  🎤 ${text}                    `);
  });

  // Predictive prefetch: warm cache when user starts speaking
  pipeline.on('command', () => {
    queryCache.prefetch().catch(() => {}); // fire-and-forget
  });

  pipeline.on('command:timeout', () => {
    log.info('No command received — returning to idle');
  });

  pipeline.on('state', (newState) => {
    process.stdout.write(`\x1b]0;Razor [${newState}]\x07`);
  });

  await pipeline.start();

  // Start morning briefing scheduler (8:30 AM weekdays)
  morningBriefing.start(pipeline, integrations);

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
