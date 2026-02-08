// src/context/conversation-context.js
// Three-layer intelligent conversation context manager

import makeLogger from '../utils/logger.js';

const log = makeLogger('ConversationContext');

/**
 * Layer 1: Basic Commands (already implemented)
 * Layer 2: Follow-up with entity resolution ("the first one", "call them")
 * Layer 3: Deep context chaining ("compare to last week", "prioritize over Acme")
 */

export class ConversationContext {
  constructor() {
    // Current turn context
    this.lastResponse = null;
    this.lastAction = null;
    this.lastEntities = [];
    this.lastTimestamp = null;
    
    // Session context (persists across turns)
    this.mentionedDeals = [];      // All deals mentioned this session
    this.mentionedContacts = [];   // All contacts mentioned
    this.mentionedCompanies = [];  // All companies mentioned
    this.sessionTopics = [];       // Topics discussed
    
    // Deep context (Layer 3)
    this.conversationHistory = []; // Last 10 turns
    this.pendingFollowUps = [];    // Suggested next questions
    
    // Reference resolution patterns
    this.referencePatterns = {
      first: /^(the )?(first|1st)( one)?$/i,
      second: /^(the )?(second|2nd)( one)?$/i,
      third: /^(the )?(third|3rd)( one)?$/i,
      last: /^(the )?(last)( one)?$/i,
      them: /^(them|they|those|these|all of them)$/i,
      that: /^(that|this|it)( one| deal| person| company)?$/i,
      him: /^(him|he)$/i,
      her: /^(her|she)$/i,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LAYER 2: Entity Extraction & Storage
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Extract entities from action response data
   */
  extractEntities(actionName, responseData, responseText) {
    const entities = [];
    
    if (!responseData && !responseText) return entities;

    // Handle array responses (lists of deals, contacts, etc.)
    if (Array.isArray(responseData)) {
      responseData.forEach((item, index) => {
        const entity = this._extractEntityFromItem(item, actionName, index);
        if (entity) entities.push(entity);
      });
    }
    // Handle object responses
    else if (typeof responseData === 'object' && responseData !== null) {
      const entity = this._extractEntityFromItem(responseData, actionName, 0);
      if (entity) entities.push(entity);
    }
    
    // Also parse names from response text
    if (responseText && entities.length === 0) {
      const textEntities = this._extractEntitiesFromText(responseText, actionName);
      entities.push(...textEntities);
    }

    return entities;
  }

  _extractEntityFromItem(item, actionName, index) {
    if (!item) return null;

    // Determine entity type from action
    const type = this._getEntityType(actionName);
    
    return {
      index,
      type,
      id: item.Id || item.id || item.person_id || null,
      name: item.Name || item.name || item.display_name || item.title || item.email_address || null,
      email: item.email || item.email_address || item.Email || null,
      phone: item.phone || item.phone_number || item.Phone || null,
      company: item.Account?.Name || item.company_name || item.company || null,
      amount: item.Amount || item.amount || null,
      stage: item.StageName || item.stage || null,
      raw: item, // Keep full data for deep queries
    };
  }

  _getEntityType(actionName) {
    const typeMap = {
      'get_hot_leads': 'person',
      'get_email_opens': 'person',
      'get_email_clicks': 'person',
      'get_replies': 'person',
      'lookup_contact': 'person',
      'get_pipeline': 'deal',
      'get_biggest_deal': 'deal',
      'get_stale_deals': 'deal',
      'get_deals_closing': 'deal',
      'get_deal_by_name': 'deal',
      'lookup_account': 'company',
      'get_action_items': 'task',
      'get_sf_tasks': 'task',
      'check_calendar': 'meeting',
      'get_today_meetings': 'meeting',
      'get_unread_emails': 'email',
    };
    return typeMap[actionName] || 'item';
  }

  _extractEntitiesFromText(text, actionName) {
    const entities = [];
    const type = this._getEntityType(actionName);
    
    // Pattern: "including X, Y, and Z" or "including X, Y, Z"
    const includingMatch = text.match(/including\s+([^.]+)/i);
    if (includingMatch) {
      const names = includingMatch[1]
        .replace(/ and /g, ', ')
        .split(',')
        .map(n => n.trim())
        .filter(n => n.length > 0);
      
      names.forEach((name, index) => {
        entities.push({
          index,
          type,
          name,
          id: null,
          raw: { name }
        });
      });
    }

    return entities;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LAYER 2: Reference Resolution
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Resolve references like "the first one", "them", "that deal"
   */
  resolveReference(text) {
    const normalized = text.toLowerCase().trim();
    
    // Check ordinal references
    if (this.referencePatterns.first.test(normalized)) {
      return this._getEntityByIndex(0);
    }
    if (this.referencePatterns.second.test(normalized)) {
      return this._getEntityByIndex(1);
    }
    if (this.referencePatterns.third.test(normalized)) {
      return this._getEntityByIndex(2);
    }
    if (this.referencePatterns.last.test(normalized)) {
      return this._getEntityByIndex(this.lastEntities.length - 1);
    }
    
    // Check plural references
    if (this.referencePatterns.them.test(normalized)) {
      return { type: 'multiple', entities: this.lastEntities };
    }
    
    // Check singular references
    if (this.referencePatterns.that.test(normalized)) {
      return this._getEntityByIndex(0); // Default to first/most recent
    }
    
    // Check gendered references (find matching person)
    if (this.referencePatterns.him.test(normalized)) {
      return this._findPersonByGender('male');
    }
    if (this.referencePatterns.her.test(normalized)) {
      return this._findPersonByGender('female');
    }
    
    // Check if it's a name match from session
    const nameMatch = this._findByName(normalized);
    if (nameMatch) return nameMatch;
    
    return null;
  }

  _getEntityByIndex(index) {
    if (index >= 0 && index < this.lastEntities.length) {
      return { type: 'single', entity: this.lastEntities[index] };
    }
    return null;
  }

  _findPersonByGender(gender) {
    // Simple heuristic based on common names
    const femaleNames = ['sarah', 'maria', 'daria', 'anna', 'lisa', 'jennifer', 'michelle', 'amanda', 'emily', 'rachel'];
    const maleNames = ['john', 'marcus', 'brent', 'david', 'michael', 'james', 'robert', 'william', 'daniel', 'matthew'];
    
    const targetNames = gender === 'female' ? femaleNames : maleNames;
    
    for (const entity of this.lastEntities) {
      if (entity.type === 'person' && entity.name) {
        const firstName = entity.name.split(' ')[0].toLowerCase();
        if (targetNames.includes(firstName)) {
          return { type: 'single', entity };
        }
      }
    }
    
    // Fallback to first person entity
    const person = this.lastEntities.find(e => e.type === 'person');
    return person ? { type: 'single', entity: person } : null;
  }

  _findByName(searchName) {
    // Search in last entities
    for (const entity of this.lastEntities) {
      if (entity.name?.toLowerCase().includes(searchName)) {
        return { type: 'single', entity };
      }
    }
    
    // Search in session contacts
    for (const contact of this.mentionedContacts) {
      if (contact.name?.toLowerCase().includes(searchName)) {
        return { type: 'single', entity: contact };
      }
    }
    
    // Search in session deals
    for (const deal of this.mentionedDeals) {
      if (deal.name?.toLowerCase().includes(searchName)) {
        return { type: 'single', entity: deal };
      }
    }
    
    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LAYER 2: Follow-up Intent Detection
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Detect if user input is a follow-up question
   */
  detectFollowUpIntent(userText) {
    const normalized = userText.toLowerCase().trim();
    
    const followUpPatterns = [
      // Entity references
      { pattern: /^(call|dial|phone)\s+(the\s+)?(first|second|third|last|him|her|them)/i, action: 'call_entity' },
      { pattern: /^(email|message)\s+(the\s+)?(first|second|third|last|him|her|them)/i, action: 'email_entity' },
      { pattern: /^(tell me (more )?about|more on|details on)\s+(the\s+)?(first|second|third|last|him|her|them|that)/i, action: 'expand_entity' },
      { pattern: /^(look up|lookup|find)\s+(the\s+)?(first|second|third|last|him|her|them)/i, action: 'lookup_entity' },
      
      // Expansion requests
      { pattern: /^(tell me more|more details|expand|elaborate|go on)/i, action: 'expand_last' },
      { pattern: /^(what else|anything else|who else|more)/i, action: 'continue_list' },
      { pattern: /^(why|explain|how come)/i, action: 'explain_last' },
      { pattern: /^(so what|what does that mean|impact)/i, action: 'analyze_impact' },
      
      // Action suggestions
      { pattern: /^(what should i do|next steps?|what now|prioritize)/i, action: 'suggest_action' },
      { pattern: /^(which (one )?(should i|first|is most))/i, action: 'prioritize' },
      
      // Comparison (Layer 3)
      { pattern: /^(compare|how does (that|this) compare|vs|versus)/i, action: 'compare' },
      { pattern: /^(trend|over time|compared to (last|yesterday|last week))/i, action: 'trend_analysis' },
      
      // Drill down
      { pattern: /^(break (it |that )?down|by stage|by company|breakdown)/i, action: 'breakdown' },
      { pattern: /^(filter|only show|just the)/i, action: 'filter' },
    ];
    
    for (const { pattern, action } of followUpPatterns) {
      if (pattern.test(normalized)) {
        return {
          isFollowUp: true,
          action,
          originalText: userText,
          resolvedEntity: this.resolveReference(normalized),
        };
      }
    }
    
    // Check for direct entity references without action verb
    const resolved = this.resolveReference(normalized);
    if (resolved) {
      return {
        isFollowUp: true,
        action: 'expand_entity',
        originalText: userText,
        resolvedEntity: resolved,
      };
    }
    
    return { isFollowUp: false };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LAYER 3: Deep Context & Suggested Follow-ups
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Generate intelligent follow-up suggestions based on last response
   */
  generateFollowUpSuggestions(actionName, entities) {
    const suggestions = [];
    
    const suggestionMap = {
      'get_pipeline': [
        { text: 'Break it down by stage', action: 'get_pipeline_by_stage' },
        { text: 'Which ones are at risk?', action: 'get_stale_deals' },
        { text: 'What\'s the biggest?', action: 'get_biggest_deal' },
        { text: 'What needs to close this month?', action: 'get_deals_closing' },
      ],
      'get_biggest_deal': [
        { text: 'What\'s the next step?', action: 'get_deal_next_steps' },
        { text: 'Who\'s the decision maker?', action: 'get_decision_maker' },
        { text: 'Prep me for this one', action: 'meeting_prep' },
        { text: 'What\'s the second biggest?', action: 'get_biggest_deal', params: { skip: 1 } },
      ],
      'get_hot_leads': [
        { text: 'Tell me about the first one', action: 'lookup_contact' },
        { text: 'What did they engage with?', action: 'get_engagement_history' },
        { text: 'Call the hottest one', action: 'get_phone_number' },
        { text: 'Add them to a cadence', action: 'add_to_cadence' },
      ],
      'get_email_opens': [
        { text: 'Who opened the most?', action: 'get_top_engager' },
        { text: 'Call the first one', action: 'get_phone_number' },
        { text: 'What email did they open?', action: 'get_email_details' },
        { text: 'Send a follow-up', action: 'draft_follow_up' },
      ],
      'get_stale_deals': [
        { text: 'What was the last touchpoint?', action: 'get_activity_history' },
        { text: 'Draft a re-engagement email', action: 'draft_reengagement' },
        { text: 'Should I kill any of these?', action: 'coach_deal_triage' },
        { text: 'Who\'s my contact there?', action: 'get_deal_contacts' },
      ],
      'check_calendar': [
        { text: 'Prep me for the next one', action: 'meeting_prep' },
        { text: 'Who\'s in the meeting?', action: 'get_meeting_attendees' },
        { text: 'Am I free at 3?', action: 'check_availability' },
        { text: 'Block time for prep', action: 'create_event' },
      ],
      'get_action_items': [
        { text: 'Mark the first one done', action: 'complete_action_item' },
        { text: 'Which is most urgent?', action: 'get_urgent_items' },
        { text: 'From which meeting?', action: 'get_item_source' },
        { text: 'Remind me at 3pm', action: 'create_reminder' },
      ],
      'last_meeting': [
        { text: 'What were the action items?', action: 'get_meeting_action_items' },
        { text: 'How long did I talk?', action: 'get_talk_ratio' },
        { text: 'Play the recording', action: 'get_recording_url' },
        { text: 'Send them a summary', action: 'draft_meeting_summary' },
      ],
      'get_activity_stats': [
        { text: 'How does that compare to yesterday?', action: 'get_activity_trend' },
        { text: 'Am I on pace for the week?', action: 'get_weekly_pace' },
        { text: 'Who did I call?', action: 'get_today_calls' },
        { text: 'What\'s my connect rate?', action: 'get_connect_rate' },
      ],
    };
    
    return suggestionMap[actionName] || [];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CONTEXT MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Update context after a successful response
   */
  updateContext(actionName, responseData, responseText) {
    // Extract and store entities
    const entities = this.extractEntities(actionName, responseData, responseText);
    
    this.lastAction = actionName;
    this.lastResponse = responseText;
    this.lastEntities = entities;
    this.lastTimestamp = Date.now();
    
    // Update session context
    this._updateSessionContext(entities);
    
    // Add to conversation history
    this.conversationHistory.push({
      action: actionName,
      response: responseText,
      entities,
      timestamp: this.lastTimestamp,
    });
    
    // Keep only last 10 turns
    if (this.conversationHistory.length > 10) {
      this.conversationHistory.shift();
    }
    
    // Generate follow-up suggestions
    this.pendingFollowUps = this.generateFollowUpSuggestions(actionName, entities);
    
    log.info(`Context updated: ${actionName}, ${entities.length} entities, ${this.pendingFollowUps.length} suggestions`);
  }

  _updateSessionContext(entities) {
    for (const entity of entities) {
      if (entity.type === 'person' && entity.name) {
        if (!this.mentionedContacts.find(c => c.name === entity.name)) {
          this.mentionedContacts.push(entity);
        }
      }
      if (entity.type === 'deal' && entity.name) {
        if (!this.mentionedDeals.find(d => d.name === entity.name)) {
          this.mentionedDeals.push(entity);
        }
      }
      if (entity.type === 'company' && entity.company) {
        if (!this.mentionedCompanies.find(c => c.name === entity.company)) {
          this.mentionedCompanies.push({ name: entity.company, ...entity });
        }
      }
    }
  }

  /**
   * Get context summary for brain
   */
  getContextForBrain() {
    if (!this.lastAction) return '';
    
    const parts = [];
    
    // Last action context
    parts.push(`[Last Query] ${this.lastAction}`);
    
    // Entities available for reference
    if (this.lastEntities.length > 0) {
      const entityList = this.lastEntities
        .slice(0, 5)
        .map((e, i) => `${i + 1}. ${e.name || 'Unknown'}${e.type ? ` (${e.type})` : ''}`)
        .join(', ');
      parts.push(`[Available References] ${entityList}`);
    }
    
    // Session context
    if (this.mentionedDeals.length > 0) {
      const dealNames = this.mentionedDeals.slice(0, 3).map(d => d.name).join(', ');
      parts.push(`[Session Deals] ${dealNames}`);
    }
    if (this.mentionedContacts.length > 0) {
      const contactNames = this.mentionedContacts.slice(0, 3).map(c => c.name).join(', ');
      parts.push(`[Session Contacts] ${contactNames}`);
    }
    
    // Suggested follow-ups
    if (this.pendingFollowUps.length > 0) {
      const suggestions = this.pendingFollowUps.slice(0, 3).map(s => s.text).join('; ');
      parts.push(`[Suggested Follow-ups] ${suggestions}`);
    }
    
    return parts.join('\n');
  }

  /**
   * Get proactive follow-up question for TTS
   */
  getProactiveFollowUp() {
    if (this.pendingFollowUps.length === 0) return null;
    
    // Return a natural follow-up question
    const options = this.pendingFollowUps.slice(0, 2);
    if (options.length === 1) {
      return `Want me to ${options[0].text.toLowerCase()}?`;
    }
    return `${options[0].text}, or ${options[1].text.toLowerCase()}?`;
  }

  /**
   * Clear context (e.g., on session end)
   */
  clear() {
    this.lastResponse = null;
    this.lastAction = null;
    this.lastEntities = [];
    this.lastTimestamp = null;
    this.mentionedDeals = [];
    this.mentionedContacts = [];
    this.mentionedCompanies = [];
    this.sessionTopics = [];
    this.conversationHistory = [];
    this.pendingFollowUps = [];
    log.info('Context cleared');
  }

  /**
   * Check if context is still relevant (within 5 minutes)
   */
  isContextFresh() {
    if (!this.lastTimestamp) return false;
    const fiveMinutes = 5 * 60 * 1000;
    return (Date.now() - this.lastTimestamp) < fiveMinutes;
  }
}

// Singleton instance
let instance = null;

export function getConversationContext() {
  if (!instance) {
    instance = new ConversationContext();
  }
  return instance;
}

export default ConversationContext;
