// src/context/conversation-context.js — Conversation Context Tracker
//
// Remembers recent interactions so Razor can handle follow-ups like
// "tell me more", "the first one", "call him", etc.
//
// Singleton — import { conversationContext } from '../context/conversation-context.js';

import makeLogger from '../utils/logger.js';

const log = makeLogger('Context');

class ConversationContext {
  constructor() {
    this.turns = [];
    this.maxTurns = 10;
    this.lastAction = null;
    this.lastData = null;
    this.lastEntities = [];
    this.timestamp = null;
  }

  /**
   * Add a conversation turn
   * @param {string} userInput - What the user said
   * @param {string} razorResponse - What Razor said back
   * @param {string} action - Action type that was dispatched
   * @param {*} data - Result data from the action
   */
  addTurn(userInput, razorResponse, action, data) {
    this.turns.push({
      userInput,
      razorResponse,
      action,
      data,
      timestamp: Date.now(),
    });

    // Keep only recent turns
    if (this.turns.length > this.maxTurns) {
      this.turns.shift();
    }

    // Update current context
    this.lastAction = action;
    this.lastData = data;
    this.timestamp = Date.now();

    // Extract entities
    this.extractEntities(data);

    log.info(`Turn added. Action: ${action}, Entities: ${this.lastEntities.join(', ')}`);
  }

  /**
   * Extract entity names from data for reference resolution
   * @param {*} data - Action result data
   */
  extractEntities(data) {
    this.lastEntities = [];

    if (!data) return;

    if (Array.isArray(data)) {
      // List of items (leads, deals, etc)
      this.lastEntities = data.slice(0, 5).map(item =>
        item.name || item.Name || item.display_name || '',
      ).filter(Boolean);
    } else if (typeof data === 'object') {
      // Single item
      if (data.name) this.lastEntities.push(data.name);
      if (data.Name) this.lastEntities.push(data.Name);
    }
  }

  /**
   * Resolve references like "the first one", "him", "that deal"
   * @param {string} ref - The reference text to resolve
   * @returns {*} Resolved data or null
   */
  resolveReference(ref) {
    const lower = ref.toLowerCase();

    // Ordinal references
    if (lower.includes('first') && Array.isArray(this.lastData) && this.lastData[0]) {
      return this.lastData[0];
    }
    if (lower.includes('second') && Array.isArray(this.lastData) && this.lastData[1]) {
      return this.lastData[1];
    }
    if (lower.includes('third') && Array.isArray(this.lastData) && this.lastData[2]) {
      return this.lastData[2];
    }

    // "tell me more" - return all last data
    if (lower.includes('more') || lower.includes('detail')) {
      return this.lastData;
    }

    // Pronoun references
    if (/\b(him|her|them|that person)\b/.test(lower) && this.lastEntities[0]) {
      return { name: this.lastEntities[0] };
    }

    return null;
  }

  /**
   * Check if context is still valid (within 2 minutes)
   * @returns {boolean}
   */
  isValid() {
    if (!this.timestamp) return false;
    const age = Date.now() - this.timestamp;
    return age < 120000; // 2 minutes
  }

  /**
   * Get context summary for brain (optional — for enhanced context awareness)
   * @returns {object|null}
   */
  getSummary() {
    if (!this.isValid()) return null;

    return {
      lastAction: this.lastAction,
      recentEntities: this.lastEntities.slice(0, 3),
      turnCount: this.turns.length,
    };
  }

  /**
   * Clear context
   */
  clear() {
    this.turns = [];
    this.lastAction = null;
    this.lastData = null;
    this.lastEntities = [];
    this.timestamp = null;
    log.info('Cleared');
  }
}

// Singleton
export const conversationContext = new ConversationContext();
export default conversationContext;
