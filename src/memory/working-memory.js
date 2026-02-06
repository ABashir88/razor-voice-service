// src/working-memory.js — Working Memory
// Holds the current conversation context, active deal, and prospect.
// Volatile: cleared when the topic changes or the conversation ends.
// NOT persisted to disk — lives purely in-process.

/**
 * @typedef {Object} ActiveDeal
 * @property {string} id
 * @property {string} name
 * @property {string} stage
 * @property {number} value
 * @property {string} [nextStep]
 */

/**
 * @typedef {Object} ActiveProspect
 * @property {string} id
 * @property {string} name
 * @property {string} [title]
 * @property {string} [company]
 * @property {string} [sentiment]    — 'positive' | 'neutral' | 'skeptical' | 'hostile'
 * @property {string[]} [painPoints]
 * @property {string[]} [objections]
 */

/**
 * @typedef {Object} ConversationTurn
 * @property {'user'|'assistant'|'system'} role
 * @property {string} content
 * @property {number} timestamp
 * @property {Object} [metadata]
 */

export class WorkingMemory {
  constructor() {
    this.clear();
  }

  /** Reset all working memory — called on topic change or conversation end */
  clear() {
    /** @type {ConversationTurn[]} */
    this.turns = [];

    /** @type {ActiveDeal|null} */
    this.activeDeal = null;

    /** @type {ActiveProspect|null} */
    this.activeProspect = null;

    /** @type {string|null} */
    this.currentTopic = null;

    /** @type {string|null} */
    this.currentIntent = null;

    /** @type {Map<string, any>} */
    this.scratchpad = new Map();

    /** @type {number} */
    this.startedAt = Date.now();

    /** @type {string[]} Key decisions or commitments made during this conversation */
    this.commitments = [];
  }

  /**
   * Add a conversation turn.
   * Keeps a rolling window of the last 50 turns to prevent unbounded growth.
   */
  addTurn(role, content, metadata = {}) {
    this.turns.push({
      role,
      content,
      timestamp: Date.now(),
      metadata,
    });

    // Rolling window: keep last 50 turns
    if (this.turns.length > 50) {
      this.turns = this.turns.slice(-50);
    }
  }

  /** Set or update the active deal context */
  setDeal(deal) {
    this.activeDeal = { ...deal };
  }

  /** Set or update the active prospect context */
  setProspect(prospect) {
    this.activeProspect = { ...prospect };
  }

  /** Detect if the topic has changed, and if so, return the old topic */
  updateTopic(newTopic) {
    const oldTopic = this.currentTopic;
    const changed = oldTopic && oldTopic !== newTopic;
    this.currentTopic = newTopic;
    return changed ? oldTopic : null;
  }

  /** Store a temporary value in the scratchpad */
  scratch(key, value) {
    this.scratchpad.set(key, value);
  }

  /** Read from scratchpad */
  getScratch(key) {
    return this.scratchpad.get(key);
  }

  /** Record a commitment made during the conversation */
  addCommitment(commitment) {
    this.commitments.push(commitment);
  }

  /**
   * Build a context summary for injection into the LLM prompt.
   * Returns a compact string representation of the current working memory.
   */
  toContextString() {
    const parts = [];

    if (this.activeProspect) {
      const p = this.activeProspect;
      parts.push(`[Prospect] ${p.name}${p.title ? ` — ${p.title}` : ''}${p.company ? ` @ ${p.company}` : ''}`);
      if (p.sentiment) parts.push(`  Sentiment: ${p.sentiment}`);
      if (p.painPoints?.length) parts.push(`  Pain points: ${p.painPoints.join(', ')}`);
      if (p.objections?.length) parts.push(`  Active objections: ${p.objections.join(', ')}`);
    }

    if (this.activeDeal) {
      const d = this.activeDeal;
      parts.push(`[Deal] ${d.name} — Stage: ${d.stage} — Value: $${d.value?.toLocaleString()}`);
      if (d.nextStep) parts.push(`  Next step: ${d.nextStep}`);
    }

    if (this.currentTopic) {
      parts.push(`[Topic] ${this.currentTopic}`);
    }

    if (this.commitments.length) {
      parts.push(`[Commitments] ${this.commitments.join('; ')}`);
    }

    // Last 5 turns as recent context
    const recent = this.turns.slice(-5);
    if (recent.length) {
      parts.push('[Recent conversation]');
      for (const t of recent) {
        parts.push(`  ${t.role}: ${t.content.substring(0, 200)}`);
      }
    }

    return parts.join('\n');
  }

  /** Snapshot the working memory state for archival before clearing */
  snapshot() {
    return {
      turns: [...this.turns],
      activeDeal: this.activeDeal ? { ...this.activeDeal } : null,
      activeProspect: this.activeProspect ? { ...this.activeProspect } : null,
      currentTopic: this.currentTopic,
      currentIntent: this.currentIntent,
      commitments: [...this.commitments],
      startedAt: this.startedAt,
      endedAt: Date.now(),
      turnCount: this.turns.length,
    };
  }
}

export default WorkingMemory;
